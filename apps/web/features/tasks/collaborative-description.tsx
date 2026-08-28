"use client";

import * as Y from "yjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

type Connection = "connecting" | "synced" | "saving" | "offline";

interface DescriptionFrame {
  type: "bootstrap" | "update" | "ack" | "error";
  update?: string;
  snapshot?: string;
  updates?: string[];
  text?: string;
  initialized?: boolean;
  messageId?: string;
  error?: string;
}

interface CollaborativeDescriptionProps {
  projectId: string;
  taskId: string;
  initialValue: string;
  onValueChange: (value: string) => void;
}

const encode = (value: Uint8Array) => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decode = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

function replaceText(text: Y.Text, next: string) {
  const previous = text.toString();
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix += 1;
  const removeCount = previous.length - prefix - suffix;
  const insertValue = next.slice(prefix, next.length - suffix || undefined);
  text.doc?.transact(() => {
    if (removeCount) text.delete(prefix, removeCount);
    if (insertValue) text.insert(prefix, insertValue);
  }, "local");
}

export function CollaborativeDescription({ projectId, taskId, initialValue, onValueChange }: CollaborativeDescriptionProps) {
  const [session, setSession] = useState(0);
  const restartFromSharedSnapshot = useCallback(() => setSession((value) => value + 1), []);
  return <CollaborativeDescriptionSession key={session} projectId={projectId} taskId={taskId} initialValue={initialValue} onValueChange={onValueChange} onInitializationRace={restartFromSharedSnapshot} />;
}

function CollaborativeDescriptionSession({ projectId, taskId, initialValue, onValueChange, onInitializationRace }: CollaborativeDescriptionProps & { onInitializationRace: () => void }) {
  const doc = useMemo(() => new Y.Doc(), []);
  const yText = useMemo(() => doc.getText("description"), [doc]);
  const undoManager = useMemo(() => new Y.UndoManager(yText, { trackedOrigins: new Set(["local"]) }), [yText]);
  const initializedRef = useRef(false);
  const suppressRef = useRef(false);
  const [value, setValue] = useState(initialValue);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [ready, setReady] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const onValueChangeRef = useRef(onValueChange);
  const initialValueRef = useRef(initialValue);
  const initializationRaceRef = useRef(onInitializationRace);
  useEffect(() => { onValueChangeRef.current = onValueChange; }, [onValueChange]);
  useEffect(() => { initialValueRef.current = initialValue; }, [initialValue]);
  useEffect(() => { initializationRaceRef.current = onInitializationRace; }, [onInitializationRace]);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
    const socketUrl = `${baseUrl.replace(/^http/, "ws")}/v1/projects/${projectId}/tasks/${taskId}/description/live`;
    let destroyed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let reconnectAttempts = 0;
    const pending = new Map<string, string>();

    const sendUpdate = (update: Uint8Array, type: "init" | "update") => {
      const messageId = crypto.randomUUID();
      const frame = JSON.stringify({ type, messageId, update: encode(update), text: yText.toString() });
      pending.set(messageId, frame);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(frame);
        setConnection("saving");
      } else setConnection("offline");
    };

    const onUpdate = (update: Uint8Array, origin: unknown) => {
      // Yjs transactions can originate outside the textarea's onChange handler
      // (most notably UndoManager undo/redo). Keep the controlled React value
      // subscribed to every document transaction so the originating editor and
      // its collaborators always render the same document state.
      const nextValue = yText.toString();
      setValue(nextValue);
      onValueChangeRef.current(nextValue);
      if (suppressRef.current || origin === "remote" || origin === "bootstrap") return;
      sendUpdate(update, initializedRef.current ? "update" : "init");
    };
    doc.on("update", onUpdate);

    const scheduleReconnect = () => {
      if (destroyed || reconnectTimer) return;
      reconnectAttempts += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, Math.min(10_000, 300 * 2 ** reconnectAttempts) + Math.random() * 200);
    };

    const connect = () => {
      if (destroyed) return;
      setConnection("connecting");
      const current = new WebSocket(socketUrl);
      socket = current;
      current.onopen = () => { reconnectAttempts = 0; };
      current.onmessage = (event) => {
        let frame: DescriptionFrame;
        try { frame = JSON.parse(String(event.data)) as DescriptionFrame; } catch { return; }
        if (frame.type === "bootstrap") {
          suppressRef.current = true;
          try {
            if (frame.initialized && frame.snapshot) Y.applyUpdate(doc, decode(frame.snapshot), "bootstrap");
            else if (!yText.length) doc.transact(() => yText.insert(0, frame.text ?? initialValueRef.current), "bootstrap");
            for (const update of frame.updates ?? []) Y.applyUpdate(doc, decode(update), "bootstrap");
          } catch {
            setConnection("offline");
            current.close();
            return;
          } finally { suppressRef.current = false; }
          initializedRef.current = Boolean(frame.initialized);
          if (!frame.initialized) sendUpdate(Y.encodeStateAsUpdate(doc), "init");
          else for (const queued of pending.values()) if (current.readyState === WebSocket.OPEN) current.send(queued);
          setReady(Boolean(frame.initialized));
          setValue(yText.toString());
          onValueChangeRef.current(yText.toString());
          setConnection(pending.size ? "saving" : "synced");
        } else if (frame.type === "update" && frame.update) {
          suppressRef.current = true;
          try { Y.applyUpdate(doc, decode(frame.update), "remote"); } catch { setConnection("offline"); } finally { suppressRef.current = false; }
          setValue(yText.toString());
          onValueChangeRef.current(yText.toString());
          setReady(true);
          setConnection(pending.size ? "saving" : "synced");
        } else if (frame.type === "ack" && frame.messageId) {
          pending.delete(frame.messageId);
          initializedRef.current = true;
          setReady(true);
          setConnection(pending.size ? "saving" : "synced");
        } else if (frame.type === "error") {
          if (frame.error === "DESCRIPTION_ALREADY_INITIALIZED") initializationRaceRef.current();
          else setConnection("offline");
        }
      };
      current.onerror = () => setConnection("offline");
      current.onclose = () => {
        if (socket === current) socket = null;
        if (!destroyed) { setConnection("offline"); scheduleReconnect(); }
      };
    };
    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      doc.off("update", onUpdate);
      socket?.close();
      undoManager.destroy();
      doc.destroy();
    };
  }, [doc, projectId, taskId, undoManager, yText]);

  useEffect(() => {
    const refresh = () => setHistory({ canUndo: undoManager.canUndo(), canRedo: undoManager.canRedo() });
    undoManager.on("stack-item-added", refresh);
    undoManager.on("stack-item-popped", refresh);
    undoManager.on("stack-cleared", refresh);
    return () => {
      undoManager.off("stack-item-added", refresh);
      undoManager.off("stack-item-popped", refresh);
      undoManager.off("stack-cleared", refresh);
    };
  }, [undoManager]);

  const statusText = { connecting: "Connecting…", saving: "Saving…", synced: "Synced", offline: "Offline — edits stay local" }[connection];
  return (
    <div className="mt-3">
      <Textarea
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          replaceText(yText, next);
          setValue(next);
          onValueChange(next);
        }}
        rows={7}
        disabled={!ready}
        placeholder="Describe the outcome, context, and acceptance criteria…"
        aria-label="Collaborative task description"
      />
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
        <span className={connection === "offline" ? "text-[var(--warning-text)]" : undefined}>{statusText}</span>
        <div className="flex items-center gap-1">
          <span className="mr-1">Collaborative document</span>
          <Button type="button" variant="ghost" size="icon" className="size-7" disabled={!history.canUndo} aria-label="Undo my description edit" title="Undo my description edit" onClick={() => undoManager.undo()}><Undo2 className="size-3.5" /></Button>
          <Button type="button" variant="ghost" size="icon" className="size-7" disabled={!history.canRedo} aria-label="Redo my description edit" title="Redo my description edit" onClick={() => undoManager.redo()}><Redo2 className="size-3.5" /></Button>
        </div>
      </div>
    </div>
  );
}
