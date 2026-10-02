// While someone is in calling mode, the calling screen asks how each call went, so the RingCentral
// phone's own "How did it go?" box stays out of the way (the result goes on that same call).
let active = false;

export function setCallingMode(on: boolean) {
  active = on;
}

export function isCallingMode() {
  return active;
}
