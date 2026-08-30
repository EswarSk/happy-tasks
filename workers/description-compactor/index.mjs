import pg from "pg";
import { mergeDescription } from "./compact.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const threshold = Math.max(10, Number(process.env.COMPACTION_THRESHOLD ?? 500));
const intervalMs = Math.max(1000, Number(process.env.COMPACTION_INTERVAL_MS ?? 5000));
const idleMs = intervalMs * 2;
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
let stopping = false;

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function compact(projectId, taskId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const document = await client.query(`
      SELECT snapshot
      FROM task_description_documents
      WHERE project_id = $1 AND task_id = $2 AND initialized = true
      FOR UPDATE`, [projectId, taskId]);
    if (!document.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    const updates = await client.query(`
      SELECT id, update_data
      FROM task_description_updates
      WHERE project_id = $1 AND task_id = $2
      ORDER BY id`, [projectId, taskId]);
    if (!updates.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    const merged = mergeDescription(document.rows[0].snapshot, updates.rows.map((row) => row.update_data));
    const lastId = updates.rows.at(-1).id;
    await client.query(`
      UPDATE task_description_documents
      SET snapshot = $3, updated_at = now()
      WHERE project_id = $1 AND task_id = $2`, [projectId, taskId, merged.snapshot]);
    await client.query(`
      DELETE FROM task_description_updates
      WHERE project_id = $1 AND task_id = $2 AND id <= $3`, [projectId, taskId, lastId]);
    await client.query(`
      UPDATE tasks SET description = $3
      WHERE project_id = $1 AND id = $2`, [projectId, taskId, merged.text]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

while (!stopping) {
  try {
    const candidates = await pool.query(`
      SELECT project_id, task_id
      FROM task_description_updates
      GROUP BY project_id, task_id
      HAVING count(*) >= $1
          OR max(created_at) <= now() - $2::double precision * interval '1 millisecond'
      ORDER BY min(id)
      LIMIT 20`, [threshold, idleMs]);
    for (const candidate of candidates.rows) {
      if (stopping) break;
      if (await compact(candidate.project_id, candidate.task_id)) {
        console.log(JSON.stringify({ message: "description compacted", projectId: candidate.project_id, taskId: candidate.task_id }));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ message: "description compaction failed", error: error.message }));
  }
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

await pool.end();
