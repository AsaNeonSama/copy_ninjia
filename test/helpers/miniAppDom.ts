/**
 * Mini App 前端组件测试共用的最小 DOM 替身：只实现 react-dom 客户端渲染、受控输入、行内样式、
 * 属性读写与点击冒泡（经 react-dom 挂在根容器与 document 上的监听器）所需的节点接口。
 *
 * `installMiniDom` 接管 `document`、`window` 与 `IS_REACT_ACT_ENVIRONMENT` 三个全局量，
 * 返回的 `restore` 按安装前的状态逐个还原（安装前不存在的全局量直接删除）。
 */

/** 最小 DOM 节点：元素（1）、文本（3）与注释（8）共用同一实现。 */
export class MiniDomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  parentNode: MiniDomNode | null = null;
  childNodes: MiniDomNode[] = [];
  readonly ownerDocument: MiniDomDocument;
  readonly style: Record<string, string> = {};
  readonly attributes: Map<string, string> = new Map<string, string>();
  value: string = "";
  textContentValue: string = "";
  scrollTop: number = 0;
  offsetHeight: number = 0;
  private readonly listeners: Map<string, Set<unknown>> = new Map<string, Set<unknown>>();

  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDomDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.tagName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): MiniDomNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): MiniDomNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): MiniDomNode | null {
    if (this.parentNode === null) return null;
    const index: number = this.parentNode.childNodes.indexOf(this);
    return index >= 0 && index + 1 < this.parentNode.childNodes.length
      ? this.parentNode.childNodes[index + 1]!
      : null;
  }
  get previousSibling(): MiniDomNode | null {
    if (this.parentNode === null) return null;
    const index: number = this.parentNode.childNodes.indexOf(this);
    return index > 0 ? this.parentNode.childNodes[index - 1]! : null;
  }
  get previousElementSibling(): MiniDomNode | null { return this.previousSibling; }
  get nextElementSibling(): MiniDomNode | null { return this.nextSibling; }
  get parentElement(): MiniDomNode | null { return this.parentNode; }
  get textContent(): string { return this.textContentValue; }
  set textContent(value: string) { this.textContentValue = value ?? ""; this.childNodes = []; }
  get nodeValue(): string { return this.textContentValue; }
  set nodeValue(value: string) { this.textContentValue = value ?? ""; }
  appendChild(child: MiniDomNode): MiniDomNode {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: MiniDomNode, ref: MiniDomNode | null): MiniDomNode {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    if (ref === null) {
      this.childNodes.push(child);
      return child;
    }
    const index: number = this.childNodes.indexOf(ref);
    if (index === -1) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }
  removeChild(child: MiniDomNode): MiniDomNode {
    const index: number = this.childNodes.indexOf(child);
    if (index !== -1) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  setAttributeNS(_ns: string, name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: unknown): void {
    let set: Set<unknown> | undefined = this.listeners.get(type);
    if (set === undefined) {
      set = new Set<unknown>();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: unknown): void { this.listeners.get(type)?.delete(listener); }
  scrollTo(): void {}
  contains(other: MiniDomNode | null): boolean {
    let current: MiniDomNode | null = other;
    while (current !== null) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  /**
   * 取本节点上登记的某类事件监听器。
   * @param type 事件类型。
   * @returns 监听器集合；未登记时为 undefined。
   */
  listenersOf(type: string): ReadonlySet<unknown> | undefined {
    return this.listeners.get(type);
  }
  /** 从本节点发起一次冒泡点击。 */
  triggerClick(): void {
    dispatchClickBubble(this);
  }
}

/** 最小 DOM 文档：创建节点，并承接 react-dom 挂在 document 上的监听器。 */
export class MiniDomDocument {
  readonly nodeType: number = 9;
  readonly documentElement: MiniDomNode;
  readonly body: MiniDomNode;
  activeElement: MiniDomNode | null = null;
  readonly defaultView: unknown;
  private readonly listeners: Map<string, Set<unknown>> = new Map<string, Set<unknown>>();

  constructor(defaultView: unknown) {
    this.defaultView = defaultView;
    this.documentElement = new MiniDomNode(1, "HTML", this);
    this.body = new MiniDomNode(1, "BODY", this);
    this.documentElement.appendChild(this.body);
  }
  addEventListener(type: string, listener: unknown): void {
    let set: Set<unknown> | undefined = this.listeners.get(type);
    if (set === undefined) {
      set = new Set<unknown>();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: unknown): void { this.listeners.get(type)?.delete(listener); }
  /**
   * 依次调用文档上登记的某类事件监听器。
   * @param type 事件类型。
   * @param event 事件对象。
   */
  dispatchListeners(type: string, event: unknown): void {
    const set: Set<unknown> | undefined = this.listeners.get(type);
    if (set === undefined) return;
    for (const listener of set) {
      if (typeof listener === "function") listener(event);
    }
  }
  createElement(tag: string): MiniDomNode { return new MiniDomNode(1, tag.toUpperCase(), this); }
  createElementNS(_ns: string, tag: string): MiniDomNode { return new MiniDomNode(1, tag, this); }
  createTextNode(text: string): MiniDomNode {
    const node: MiniDomNode = new MiniDomNode(3, "#text", this);
    node.textContentValue = text;
    return node;
  }
  createComment(text: string): MiniDomNode {
    const node: MiniDomNode = new MiniDomNode(8, "#comment", this);
    node.textContentValue = text;
    return node;
  }
}

/**
 * 从目标节点向上逐层调用点击监听器，未被拦截时最后交给 document。
 * @param target 点击发生的节点。
 */
function dispatchClickBubble(target: MiniDomNode): void {
  let stopped: boolean = false;
  const event: {
    type: string;
    bubbles: boolean;
    target: MiniDomNode;
    currentTarget: MiniDomNode | MiniDomDocument;
    preventDefault: () => void;
    stopPropagation: () => void;
    stopImmediatePropagation: () => void;
  } = {
    type: "click",
    bubbles: true,
    target,
    currentTarget: target,
    preventDefault(): void {},
    stopPropagation(): void {
      stopped = true;
    },
    stopImmediatePropagation(): void {
      stopped = true;
    },
  };
  let cursor: MiniDomNode | null = target;
  while (cursor !== null && !stopped) {
    event.currentTarget = cursor;
    const listeners: ReadonlySet<unknown> | undefined = cursor.listenersOf("click");
    if (listeners !== undefined) {
      for (const listener of listeners) {
        if (typeof listener === "function") listener(event);
      }
    }
    cursor = cursor.parentNode;
  }
  if (!stopped) {
    event.currentTarget = target.ownerDocument;
    target.ownerDocument.dispatchListeners("click", event);
  }
}

/**
 * 拼接子树内全部文本（元素无子节点时取其 `textContent`）。
 * @param node 子树根节点。
 * @returns 子树文本。
 */
export function collectNodeText(node: MiniDomNode): string {
  if (node.nodeType === 3 || node.childNodes.length === 0) return node.textContentValue;
  return node.childNodes.map(collectNodeText).join("");
}

/**
 * 深度优先收集子树内满足条件的元素节点。
 * @param node 子树根节点。
 * @param predicate 元素筛选条件。
 * @returns 命中的元素节点，按文档顺序排列。
 */
export function findElements(
  node: MiniDomNode,
  predicate: (element: MiniDomNode) => boolean
): MiniDomNode[] {
  const out: MiniDomNode[] = [];
  const visit = (current: MiniDomNode): void => {
    if (current.nodeType === 1 && predicate(current)) out.push(current);
    for (const child of current.childNodes) visit(child);
  };
  visit(node);
  return out;
}

/**
 * 查找文本包含指定内容的第一个按钮。
 * @param node 子树根节点。
 * @param text 按钮文本片段。
 * @returns 命中的按钮；没有时为 null。
 */
export function findButtonByText(node: MiniDomNode, text: string): MiniDomNode | null {
  return findElements(
    node,
    (element: MiniDomNode): boolean => element.tagName === "BUTTON" && collectNodeText(element).includes(text)
  )[0] ?? null;
}

/**
 * 判断元素 `class` 属性是否包含指定类名。
 * @param element 元素节点。
 * @param className 类名。
 * @returns 包含时返回 true。
 */
export function hasClass(element: MiniDomNode, className: string): boolean {
  return (element.getAttribute("class") ?? "").split(/\s+/u).includes(className);
}

/**
 * 收集子树内全部非空 `<input>` / `<textarea>` 的当前值。
 * @param node 子树根节点。
 * @returns 输入框当前值列表。
 */
export function inputValues(node: MiniDomNode): string[] {
  return findElements(
    node,
    (element: MiniDomNode): boolean =>
      (element.tagName === "INPUT" || element.tagName === "TEXTAREA") && element.value.length > 0
  ).map((element: MiniDomNode): string => element.value);
}

/** 已安装的最小 DOM 环境。 */
export interface MiniDomEnvironment {
  /** 当前全局 `document`。 */
  readonly document: MiniDomDocument;
  /** 还原安装前的 `document`、`window` 与 `IS_REACT_ACT_ENVIRONMENT`。 */
  readonly restore: () => void;
}

/** 测试期间被接管的全局量。 */
interface MiniDomGlobals {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
  document?: unknown;
  window?: unknown;
}

/**
 * 安装最小 DOM 与 React act 环境。
 * @returns 环境句柄（含还原函数）。
 */
export function installMiniDom(): MiniDomEnvironment {
  const globals: MiniDomGlobals = globalThis as MiniDomGlobals;
  const hadAct: boolean = "IS_REACT_ACT_ENVIRONMENT" in globals;
  const hadDocument: boolean = "document" in globals;
  const hadWindow: boolean = "window" in globals;
  const prevAct: boolean | undefined = globals.IS_REACT_ACT_ENVIRONMENT;
  const prevDocument: unknown = globals.document;
  const prevWindow: unknown = globals.window;
  const miniWindow: Record<string, unknown> = {
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    getComputedStyle: (): { display: string; marginBottom: string } => ({ display: "block", marginBottom: "0px" }),
    HTMLIFrameElement: class MiniHTMLIFrameElement {},
  };
  const miniDocument: MiniDomDocument = new MiniDomDocument(miniWindow);
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.document = miniDocument;
  globals.window = miniWindow;
  return {
    document: miniDocument,
    restore: (): void => {
      if (hadAct) globals.IS_REACT_ACT_ENVIRONMENT = prevAct;
      else delete globals.IS_REACT_ACT_ENVIRONMENT;
      if (hadDocument) globals.document = prevDocument;
      else delete globals.document;
      if (hadWindow) globals.window = prevWindow;
      else delete globals.window;
    },
  };
}
