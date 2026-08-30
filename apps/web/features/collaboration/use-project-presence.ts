"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dataSource, demoActorId } from "@/lib/api";

export interface CollaboratorPresence {
  sessionId: string;
  actorId: string;
  taskId?: string;
  selectionFrom?: number;
  selectionTo?: number;
}

interface PresenceFrame extends CollaboratorPresence {
  type: "presence" | "leave" | "welcome";
}

const newSessionId = () => crypto.randomUUID();

export function taskCollaborators(peers: Iterable<CollaboratorPresence>, taskId?: string, currentActorId?: string) {
  if (!taskId) return [];
  const actors = new Map<string, CollaboratorPresence>();
  for (const peer of peers) {
    if (peer.taskId === taskId && peer.actorId !== currentActorId) actors.set(peer.actorId, peer);
  }
  return [...actors.values()];
}

export function useProjectPresence(projectId: string, taskId?: string, currentActorId?: string, enabled = true) {
  const [sessionId] = useState(newSessionId);
  const [collaborators, setCollaborators] = useState<CollaboratorPresence[]>([]);
  const currentTask = useRef(taskId);
  const serverSession = useRef(sessionId);
  const selection = useRef({ from: 0, to: 0 });
  const sendRef = useRef<(frame: PresenceFrame) => void>(() => undefined);

  const updateSelection = useCallback((from: number, to: number) => {
    selection.current = { from, to };
    sendRef.current({ type: "presence", sessionId, actorId: demoActorId, taskId: currentTask.current, selectionFrom: from, selectionTo: to });
  }, [sessionId]);

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | undefined;
    let channel: BroadcastChannel | undefined;
    let reconnectTimer: number | undefined;
    let reconnectAttempts = 0;
    let destroyed = false;
    const peers = new Map<string, CollaboratorPresence>();
    const publishPeers = () => setCollaborators(taskCollaborators(peers.values(), currentTask.current, currentActorId));
    const apply = (frame: PresenceFrame) => {
      if (frame.type === "welcome") { serverSession.current = frame.sessionId; return; }
      if (frame.sessionId === serverSession.current) return;
      if (frame.type === "leave") peers.delete(frame.sessionId);
      else if (frame.type === "presence") {
        peers.delete(frame.sessionId);
        peers.set(frame.sessionId, { sessionId: frame.sessionId, actorId: frame.actorId, taskId: frame.taskId, selectionFrom: frame.selectionFrom, selectionTo: frame.selectionTo });
      }
      publishPeers();
    };
    const presence = (): PresenceFrame => ({ type: "presence", sessionId, actorId: demoActorId, taskId: currentTask.current, selectionFrom: selection.current.from, selectionTo: selection.current.to });

    if (dataSource === "mock" && typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(`happy-tasks-presence:${projectId}`);
      channel.onmessage = (event) => apply(event.data as PresenceFrame);
      sendRef.current = (frame) => channel?.postMessage(frame);
    } else if (dataSource === "api") {
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
      const connect = () => {
        if (destroyed) return;
        const current = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/v1/projects/${projectId}/collaboration/live`);
        socket = current;
        current.onmessage = (event) => {
          try { apply(JSON.parse(String(event.data)) as PresenceFrame); } catch { /* Ignore malformed ephemeral frames. */ }
        };
        current.onopen = () => { reconnectAttempts = 0; sendRef.current(presence()); };
        current.onclose = () => {
          if (destroyed || socket !== current) return;
          reconnectAttempts += 1;
          reconnectTimer = window.setTimeout(connect, Math.min(10_000, 300 * 2 ** reconnectAttempts) + Math.random() * 200);
        };
      };
      sendRef.current = (frame) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); };
      connect();
    }
    const announce = () => sendRef.current(presence());
    announce();
    const timer = window.setInterval(announce, 15_000);
    const leave = () => sendRef.current({ type: "leave", sessionId, actorId: demoActorId });
    window.addEventListener("beforeunload", leave);
    return () => {
      destroyed = true;
      window.clearInterval(timer);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      window.removeEventListener("beforeunload", leave);
      leave();
      channel?.close();
      socket?.close();
      sendRef.current = () => undefined;
      setCollaborators([]);
    };
  }, [currentActorId, enabled, projectId, sessionId, taskId]);

  useEffect(() => {
    currentTask.current = taskId;
    sendRef.current({ type: "presence", sessionId, actorId: demoActorId, taskId, selectionFrom: selection.current.from, selectionTo: selection.current.to });
  }, [sessionId, taskId]);

  return { collaborators, updateSelection };
}
