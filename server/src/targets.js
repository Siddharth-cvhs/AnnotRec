// Which page the viewport proxy currently forwards to. One per AnnotRec
// instance, shared by the target route and the proxy.

export class Targets {
  constructor(initial = null) {
    this.origin = initial;
  }

  get() {
    return this.origin;
  }

  set(origin) {
    this.origin = origin;
  }
}
