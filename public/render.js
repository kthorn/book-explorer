const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

function text(document, value) {
  return document.createTextNode(value == null ? "" : String(value));
}

function element(document, tagName, className) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

function append(parent, ...children) {
  for (const child of children) {
    if (!child) continue;
    if (typeof parent.appendChild === "function") parent.appendChild(child);
    else parent.append(child);
  }
  return parent;
}

function attribute(node, name, value) {
  if (typeof node.setAttribute === "function")
    node.setAttribute(name, String(value));
}

function on(node, eventName, listener) {
  if (typeof node.addEventListener === "function")
    node.addEventListener(eventName, listener);
}

function primitiveText(value) {
  if (value == null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  return "";
}

function messageText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(messageText).join("");
  if (value && typeof value === "object") {
    const part = value;
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
  }
  return "";
}

export function safeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return HTTP_PROTOCOLS.has(url.protocol.toLowerCase()) ? url.href : null;
  } catch {
    return null;
  }
}

export function createStreamContext(conversationId) {
  return {
    token: Symbol("book-explorer-stream"),
    conversationId,
    assistantText: "",
    assistantNode: null,
    recommendationNode: null,
    activityNode: null,
    toolCalls: new Map(),
    terminal: false,
  };
}

export function recordToolStatus(context, status) {
  context.toolCalls.set(status.toolCallId, status);
  return `Using ${status.toolName}…`;
}

export function summarizeToolActivity(context) {
  const calls = [...context.toolCalls.values()];
  const failures = calls.filter((call) => call.isError === true).length;
  return `${failures ? "⚠" : "✓"} Used ${calls.length} tool${
    calls.length === 1 ? "" : "s"
  }${failures ? ` · ${failures} failed` : ""}`;
}

export function isCurrentStream(context, activeContext, conversationId) {
  return Boolean(
    context &&
      activeContext &&
      context === activeContext &&
      context.token === activeContext.token &&
      context.conversationId === conversationId,
  );
}

export function markStreamTerminal(context, event) {
  if (event?.type === "complete" || event?.type === "error")
    context.terminal = true;
  return context.terminal;
}

export function streamNeedsIncomplete(context) {
  return context.terminal !== true;
}

export function renderMessage(document, message, options = {}) {
  const role = message?.role === "user" ? "user" : "assistant";
  const incomplete =
    message?.incomplete === true || options.incomplete === true;
  const container = element(
    document,
    "article",
    `chat ${role === "user" ? "chat-end" : "chat-start"}${incomplete ? " message-incomplete" : ""}`,
  );
  attribute(container, "data-role", role);
  if (incomplete) attribute(container, "data-incomplete", "true");

  const heading = element(
    document,
    "div",
    "chat-header mb-1 text-xs opacity-60",
  );
  append(heading, text(document, role === "user" ? "You" : "Assistant"));
  const body = element(
    document,
    "div",
    `chat-bubble whitespace-pre-wrap break-words${role === "user" ? " chat-bubble-primary" : ""}`,
  );
  append(body, text(document, messageText(message?.content)));
  append(container, heading, body);
  if (incomplete) {
    const marker = element(
      document,
      "span",
      "chat-footer mt-1 text-xs text-warning",
    );
    append(marker, text(document, "Incomplete response"));
    append(container, marker);
  }
  return container;
}

export function renderAssistantMessage(document, content, incomplete = false) {
  return renderMessage(document, { role: "assistant", content, incomplete });
}

export function renderCitation(document, citation) {
  const href = safeHttpUrl(citation?.url);
  if (!href) return null;
  const link = element(document, "a", "link link-primary");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  attribute(link, "href", href);
  attribute(link, "target", "_blank");
  attribute(link, "rel", "noopener noreferrer");
  append(link, text(document, primitiveText(citation?.title) || href));
  return link;
}

export function renderCitations(document, citations) {
  const sources = element(document, "section", "mt-3 text-sm");
  append(sources, text(document, "Sources"));
  const list = element(document, "ul", "mt-1 list-disc space-y-1 pl-5");
  for (const citation of Array.isArray(citations) ? citations : []) {
    const link = renderCitation(document, citation);
    if (!link) continue;
    const item = element(document, "li");
    append(item, link);
    if (typeof citation?.snippet === "string" && citation.snippet) {
      const snippet = element(
        document,
        "span",
        "block whitespace-pre-wrap break-words text-xs opacity-60",
      );
      append(snippet, text(document, citation.snippet));
      append(item, text(document, " — "), snippet);
    }
    append(list, item);
  }
  append(sources, list);
  return sources;
}

export function renderCover(document, coverUrl, alt = "") {
  const src = safeHttpUrl(coverUrl);
  if (!src) return null;
  const image = element(
    document,
    "img",
    "h-28 w-20 shrink-0 rounded-box bg-base-300 object-cover",
  );
  image.src = src;
  image.alt = primitiveText(alt);
  image.referrerPolicy = "no-referrer";
  attribute(image, "src", src);
  attribute(image, "alt", primitiveText(alt));
  attribute(image, "referrerpolicy", "no-referrer");
  return image;
}

export const renderBookCover = renderCover;

function bookFor(value) {
  return value?.book && typeof value.book === "object" ? value.book : value;
}

function field(document, label, value, className = "") {
  const row = element(
    document,
    "div",
    `grid grid-cols-[6rem_minmax(0,1fr)] gap-2 py-1 ${className}`,
  );
  const name = element(document, "dt", "text-sm opacity-60");
  const content = element(
    document,
    "dd",
    "min-w-0 whitespace-pre-wrap break-words",
  );
  append(name, text(document, label));
  append(content, text(document, primitiveText(value) || "—"));
  append(row, name, content);
  return row;
}

function actionButton(document, label, action, callback) {
  const button = element(document, "button", "btn btn-ghost btn-sm");
  button.type = "button";
  attribute(button, "type", "button");
  attribute(button, "data-action", action);
  append(button, text(document, label));
  if (callback) on(button, "click", () => callback(action));
  return button;
}

export function renderRecommendationCard(
  document,
  recommendation,
  options = {},
) {
  const book = bookFor(recommendation) || {};
  const card = element(
    document,
    "article",
    "card card-side bg-base-100 shadow-sm",
  );
  if (book.id != null) attribute(card, "data-book-id", book.id);
  const cover = renderCover(document, book.coverUrl, book.title);
  if (cover) append(card, cover);
  const content = element(document, "div", "card-body min-w-0 p-4");
  const title = element(document, "h3", "card-title");
  append(title, text(document, primitiveText(book.title) || "Untitled"));
  const author = element(document, "p", "opacity-60");
  append(author, text(document, primitiveText(book.author)));
  append(content, title, author);
  if (book.seriesName || book.seriesPosition) {
    append(
      content,
      field(
        document,
        "Series",
        [book.seriesName, book.seriesPosition].filter(Boolean).join(" · "),
        "recommendation-series",
      ),
    );
  }
  append(
    content,
    field(
      document,
      "Rationale",
      recommendation?.rationale,
      "recommendation-rationale",
    ),
  );
  if (recommendation?.cautions)
    append(
      content,
      field(
        document,
        "Cautions",
        recommendation.cautions,
        "recommendation-cautions",
      ),
    );
  append(
    content,
    field(document, "Status", book.status, "recommendation-status"),
  );

  const citations = Array.isArray(recommendation?.citations)
    ? recommendation.citations
    : [];
  if (citations.length) append(content, renderCitations(document, citations));

  const actions = element(document, "div", "card-actions mt-3 flex-wrap");
  const buttons = [
    ["Interested", "interested"],
    ["Reading", "reading"],
    ["Not interested", "not_interested"],
    ["Open book", "open"],
  ];
  for (const [label, action] of buttons) {
    append(
      actions,
      actionButton(document, label, action, (name) =>
        options.onAction?.(name, recommendation),
      ),
    );
  }
  append(content, actions);
  append(card, content);
  return card;
}

export function renderBookSummary(document, book, options = {}) {
  const card = element(
    document,
    "article",
    "card card-side bg-base-100 shadow-sm",
  );
  attribute(card, "data-book-id", book?.id ?? "");
  const cover = renderCover(document, book?.coverUrl, book?.title);
  if (cover) append(card, cover);
  const content = element(document, "div", "card-body min-w-0 p-4");
  const title = element(document, "h3", "card-title");
  append(title, text(document, primitiveText(book?.title) || "Untitled"));
  const author = element(document, "p", "opacity-60");
  append(author, text(document, primitiveText(book?.author)));
  append(
    content,
    title,
    author,
    field(document, "Status", book?.status),
    field(document, "Rating", book?.rating),
  );
  if (book?.seriesName)
    append(content, field(document, "Series", book.seriesName));
  const open = actionButton(document, "Open", "open", () =>
    options.onOpen?.(book),
  );
  append(content, open);
  append(card, content);
  return card;
}

export function renderLibrary(document, books, options = {}) {
  const list = element(document, "section", "grid gap-3");
  let count = 0;
  for (const book of Array.isArray(books) ? books : []) {
    append(list, renderBookSummary(document, book, options));
    count += 1;
  }
  if (count === 0) {
    const empty = element(document, "p", "py-8 text-center opacity-60");
    append(empty, text(document, "No books found."));
    append(list, empty);
  }
  return list;
}

export function renderConversationList(document, conversations, options = {}) {
  const list = element(document, "nav", "menu menu-sm w-full gap-1 p-0");
  attribute(list, "aria-label", "Conversations");
  for (const conversation of Array.isArray(conversations)
    ? conversations
    : []) {
    const row = element(
      document,
      "div",
      "grid grid-cols-[minmax(0,1fr)_auto] gap-1",
    );
    const button = actionButton(
      document,
      primitiveText(conversation?.name) || "Unnamed conversation",
      "open",
      () => options.onOpen?.(conversation),
    );
    button.className += ` min-w-0 justify-start truncate${conversation?.id === options.activeId ? " btn-active" : ""}`;
    attribute(button, "data-conversation-id", conversation?.id ?? "");

    const dropdown = element(document, "details", "dropdown dropdown-end");
    const trigger = element(document, "summary", "btn btn-ghost btn-sm");
    append(trigger, text(document, "Actions"));
    const actions = element(
      document,
      "ul",
      "menu dropdown-content right-0 z-10 w-32 rounded-box bg-base-100 p-2 shadow",
    );
    const rename = actionButton(document, "Rename", "rename", () =>
      options.onRename?.(conversation),
    );
    const archive = actionButton(
      document,
      conversation?.archived ? "Restore" : "Archive",
      "archive",
      () => options.onArchive?.(conversation),
    );
    const remove = actionButton(document, "Delete", "delete", () =>
      options.onDelete?.(conversation),
    );
    for (const control of [rename, archive, remove]) {
      const item = element(document, "li");
      append(item, control);
      append(actions, item);
    }
    append(dropdown, trigger, actions);
    if (options.disabled === true) {
      for (const control of [button, rename, archive, remove]) {
        control.disabled = true;
        attribute(control, "disabled", "");
      }
      trigger.className += " pointer-events-none opacity-50";
      attribute(trigger, "aria-disabled", "true");
    }
    append(row, button, dropdown);
    append(list, row);
  }
  return list;
}

export function renderProposal(document, proposal, options = {}) {
  const card = element(document, "article", "card bg-base-200 p-4");
  attribute(card, "data-proposal-id", proposal?.proposalId ?? "");
  const heading = element(document, "h3", "card-title");
  append(heading, text(document, "Proposed change"));
  append(
    card,
    heading,
    field(document, "Kind", proposal?.kind),
    field(document, "Value", proposal?.value),
    field(document, "Explanation", proposal?.explanation),
  );
  const actions = element(document, "div", "card-actions mt-3 flex-wrap");
  append(
    actions,
    actionButton(document, "Accept", "accept", () =>
      options.onAccept?.(proposal),
    ),
    actionButton(document, "Edit and accept", "edit", () =>
      options.onEdit?.(proposal),
    ),
    actionButton(document, "Reject", "reject", () =>
      options.onReject?.(proposal),
    ),
  );
  append(card, actions);
  return card;
}

export const renderCitationLink = renderCitation;
export const renderCoverImage = renderCover;
export const renderChatMessage = renderMessage;

export function renderBookDetails(document, book, options = {}) {
  const panel = element(document, "section", "card bg-base-200 p-4");
  const heading = element(document, "h2", "card-title");
  append(heading, text(document, primitiveText(book?.title) || "Book"));
  append(panel, heading);
  const cover = renderCover(document, book?.coverUrl, book?.title);
  if (cover) append(panel, cover);
  append(
    panel,
    field(document, "Author", book?.author),
    field(document, "Publication year", book?.publicationYear),
    field(document, "Series", book?.seriesName),
    field(document, "Series position", book?.seriesPosition),
    field(document, "Status", book?.status),
    field(document, "Rating", book?.rating),
  );
  const edit = actionButton(document, "Edit book", "edit", () =>
    options.onEdit?.(book),
  );
  append(panel, edit);

  if (Array.isArray(book?.notes) && book.notes.length) {
    const notes = element(
      document,
      "section",
      "mt-4 border-t border-base-300 pt-4",
    );
    const title = element(document, "h3");
    append(title, text(document, "Notes"));
    append(notes, title);
    for (const note of book.notes) {
      const item = element(
        document,
        "article",
        "border-b border-base-300 py-3 whitespace-pre-wrap break-words",
      );
      append(item, text(document, primitiveText(note?.note)));
      const controls = element(document, "div", "mt-2 flex flex-wrap gap-1");
      append(
        controls,
        actionButton(document, "Edit", "edit-note", () =>
          options.onEditNote?.(note),
        ),
        actionButton(document, "Delete", "delete-note", () =>
          options.onDeleteNote?.(note),
        ),
      );
      append(item, controls);
      append(notes, item);
    }
    append(panel, notes);
  }
  return panel;
}

export const renderBookCard = renderBookSummary;
export const renderProposalCard = renderProposal;
