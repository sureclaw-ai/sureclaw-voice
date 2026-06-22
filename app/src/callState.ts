// Shared call-active flag consulted by the service-worker update flow in
// main.tsx. App.tsx keeps this in sync via its `active` state so that an
// incoming SW update never reloads the page mid-call. When a call ends and a
// pending reload is waiting, the page reloads then.
export const callState = { active: false, pendingReload: false };

export function setCallActive(value: boolean) {
  callState.active = value;
  if (!value && callState.pendingReload) {
    window.location.reload();
  }
}