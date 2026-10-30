const activeAvatarRequests = new Map<string, AbortController>();

export function registerAvatarRequest(requestId: string) {
  const controller = new AbortController();
  activeAvatarRequests.set(requestId, controller);
  return {
    signal: controller.signal,
    release() {
      if (activeAvatarRequests.get(requestId) === controller)
        activeAvatarRequests.delete(requestId);
    },
  };
}

export function cancelAvatarRequest(requestId: string) {
  const controller = activeAvatarRequests.get(requestId);
  if (!controller) return false;
  controller.abort();
  activeAvatarRequests.delete(requestId);
  return true;
}
