const mockListeners = new Map();

export function onMockEvent(eventName, handler) {
  if (!mockListeners.has(eventName)) {
    mockListeners.set(eventName, new Set());
  }
  const handlers = mockListeners.get(eventName);
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function emitMockEvent(eventName, payload) {
  const handlers = mockListeners.get(eventName);
  if (!handlers) return;
  for (const handler of handlers) {
    try {
      handler({ payload });
    } catch (err) {
      console.error("[mockEventBus] handler error:", err);
    }
  }
}
