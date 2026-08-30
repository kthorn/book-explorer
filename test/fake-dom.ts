export interface FakeNodeLike {
  nodeType: "element" | "text";
  tagName?: string;
  textContent: string;
  children: FakeNodeLike[];
  attributes: Record<string, string>;
  className?: string;
  rel?: string;
  href?: string;
  src?: string;
  referrerPolicy?: string;
  appendChild(child: FakeNodeLike): FakeNodeLike;
  append(...children: FakeNodeLike[]): void;
  setAttribute(name: string, value: string): void;
}

type Listener = (event: { preventDefault(): void }) => unknown;

export class FakeNode implements FakeNodeLike {
  readonly children: FakeNodeLike[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  className = "";
  rel = "";
  href = "";
  src = "";
  referrerPolicy = "";
  value = "";
  hidden = false;
  disabled = false;
  parentNode?: FakeNode;
  private text = "";

  constructor(
    readonly nodeType: "element" | "text" = "element",
    readonly tagName?: string,
  ) {}

  get firstChild(): FakeNodeLike | undefined {
    return this.children[0];
  }

  get textContent(): string {
    if (this.nodeType === "text") return this.text;
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = String(value);
    this.children.length = 0;
  }

  appendChild(child: FakeNodeLike): FakeNodeLike {
    this.children.push(child);
    if (child instanceof FakeNode) child.parentNode = this;
    return child;
  }

  append(...children: FakeNodeLike[]): void {
    for (const child of children) this.appendChild(child);
  }

  removeChild(child: FakeNodeLike): FakeNodeLike {
    this.children.splice(this.children.indexOf(child), 1);
    if (child instanceof FakeNode) child.parentNode = undefined;
    return child;
  }

  replaceChild(replacement: FakeNodeLike, child: FakeNodeLike): FakeNodeLike {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("Child not found");
    this.children[index] = replacement;
    if (child instanceof FakeNode) child.parentNode = undefined;
    if (replacement instanceof FakeNode) replacement.parentNode = this;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type: string): Promise<void> {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener({ preventDefault() {} });
    }
  }

  requestSubmit(): void {
    void this.dispatch("submit");
  }
}

export class FakeDocument {
  readonly nodes = new Map<string, FakeNode>();

  getElementById(id: string): FakeNode {
    let node = this.nodes.get(id);
    if (!node) {
      node = new FakeNode();
      this.nodes.set(id, node);
    }
    return node;
  }

  createElement(tagName: string): FakeNode {
    return new FakeNode("element", tagName.toUpperCase());
  }

  createTextNode(value: string): FakeNode {
    const node = new FakeNode("text");
    node.textContent = value;
    return node;
  }
}
