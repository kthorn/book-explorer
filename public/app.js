import {
  createStreamContext,
  isCurrentStream,
  markStreamTerminal,
  recordToolStatus,
  renderAssistantMessage,
  renderBookDetails,
  renderConversationList,
  renderLibrary,
  renderMessage,
  renderProposal,
  renderRecommendationCard,
  streamNeedsIncomplete,
  summarizeToolActivity,
} from "./render.js";

const csrfElement = document.getElementById("csrf-token");
let csrfToken = "";
try {
  csrfToken = JSON.parse(csrfElement?.textContent ?? '""');
} catch {
  csrfToken = "";
}

const state = {
  view: "chat",
  conversations: [],
  conversation: null,
  books: [],
  series: [],
  activeStream: null,
  streaming: false,
};

const byId = (id) => document.getElementById(id);
const transcript = byId("transcript");
const drawer = byId("drawer");
const drawerContent = byId("drawer-content");
const messageForm = byId("message-form");
const messageInput = byId("message-input");
const chatView = byId("chat-view");
const libraryView = byId("library-view");
const chatEmpty = byId("chat-empty");
const viewTitle = byId("view-title");
const cancelTurn = byId("cancel-turn");

function append(parent, ...children) {
  for (const child of children) {
    if (!child) continue;
    parent.appendChild(child);
  }
  return parent;
}

function clear(node) {
  while (node?.firstChild) node.removeChild(node.firstChild);
}

function nodeWithText(tagName, className, value) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  node.appendChild(document.createTextNode(value == null ? "" : String(value)));
  return node;
}

function setText(node, value) {
  if (node) node.textContent = value == null ? "" : String(value);
}

function errorMessage(error) {
  if (error?.error?.message) return String(error.error.message);
  if (error instanceof Error && error.message) return error.message;
  return "Request failed";
}

function toast(message) {
  const node = byId("toast");
  if (!node) return;
  setText(byId("toast-message"), message);
  node.hidden = false;
  window.setTimeout(() => {
    node.hidden = true;
  }, 4500);
}

function openDrawer() {
  if (drawer && !drawer.open) drawer.showModal();
}

function mutationHeaders() {
  return { "x-csrf-token": csrfToken };
}

async function jsonRequest(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = {
    Accept: "application/json",
    ...(options.body === undefined
      ? {}
      : { "content-type": "application/json" }),
    ...(method !== "GET" && method !== "HEAD" ? mutationHeaders() : {}),
    ...(options.headers ?? {}),
  };
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { error: { message: raw } };
    }
  }
  if (!response.ok) {
    const failure = new Error(payload?.error?.message || "Request failed");
    failure.error = payload?.error;
    failure.status = response.status;
    throw failure;
  }
  return payload;
}

function streamHeaders() {
  return {
    Accept: "text/event-stream",
    "content-type": "application/json",
    ...mutationHeaders(),
  };
}

async function streamRequest(path, body, onEvent) {
  const response = await fetch(path, {
    method: "POST",
    headers: streamHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const failure = new Error(
      payload?.error?.message || "Unable to start stream",
    );
    failure.error = payload?.error;
    failure.status = response.status;
    throw failure;
  }
  if (!response.body) {
    const raw = await response.text();
    if (raw) parseSse(raw, onEvent);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    buffer = parseSse(buffer, onEvent);
  }
  buffer += decoder.decode();
  if (buffer) parseSse(`${buffer}\n\n`, onEvent);
}

function parseSse(buffer, onEvent) {
  const blocks = buffer.split(/\r?\n\r?\n/u);
  const remainder = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) =>
        line.startsWith("data: ") ? line.slice(6) : line.slice(5),
      )
      .join("\n");
    if (!data) continue;
    try {
      onEvent(JSON.parse(data));
    } catch {
      toast("The server sent an invalid stream event.");
    }
  }
  return remainder;
}

function showView(view) {
  state.view = view;
  if (chatView) chatView.hidden = view !== "chat";
  if (libraryView) libraryView.hidden = view !== "library";
  setText(
    viewTitle,
    view === "library" ? "Library" : state.conversation?.name || "Conversation",
  );
}

function setNavigationDisabled(disabled) {
  for (const id of ["new-conversation", "library-link"]) {
    const button = byId(id);
    if (button) button.disabled = disabled;
  }
}

function renderSidebar() {
  const target = byId("conversation-list");
  if (!target) return;
  clear(target);
  append(
    target,
    renderConversationList(document, state.conversations, {
      activeId: state.conversation?.id,
      disabled: state.streaming,
      onOpen: (conversation) => selectConversation(conversation.id),
      onRename: (conversation) => renameConversation(conversation),
      onArchive: (conversation) => archiveConversation(conversation),
      onDelete: (conversation) => deleteConversation(conversation),
    }),
  );
}

async function loadConversations(selectFirst = true) {
  try {
    const page = await jsonRequest(
      "/api/conversations?archived=false&limit=100&offset=0",
    );
    state.conversations = Array.isArray(page?.items) ? page.items : [];
    renderSidebar();
    if (selectFirst && !state.conversation && state.conversations[0]) {
      await selectConversation(state.conversations[0].id);
    }
    if (!state.conversations.length) {
      state.conversation = null;
      showView("chat");
      renderTranscript();
      loadProposals();
    }
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function createConversation() {
  if (state.streaming) return;
  const name = window.prompt("Conversation name", "New conversation");
  if (!name?.trim()) return;
  try {
    const conversation = await jsonRequest("/api/conversations", {
      method: "POST",
      body: { name: name.trim() },
    });
    state.conversation = conversation;
    await loadConversations(false);
    await selectConversation(conversation.id);
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function renameConversation(conversation) {
  if (state.streaming) return;
  const name = window.prompt("Conversation name", conversation.name);
  if (!name?.trim()) return;
  try {
    await jsonRequest(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      body: { name: name.trim() },
    });
    await loadConversations(false);
    if (state.conversation?.id === conversation.id) {
      state.conversation =
        state.conversations.find((item) => item.id === conversation.id) ||
        state.conversation;
      showView(state.view);
    }
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function archiveConversation(conversation) {
  if (state.streaming) return;
  const archived = !conversation.archived;
  try {
    await jsonRequest(`/api/conversations/${conversation.id}/archive`, {
      method: "POST",
      body: { archived },
    });
    if (state.conversation?.id === conversation.id && archived)
      state.conversation = null;
    await loadConversations(true);
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function deleteConversation(conversation) {
  if (state.streaming) return;
  if (!window.confirm(`Delete conversation "${conversation.name}"?`)) return;
  try {
    await jsonRequest(`/api/conversations/${conversation.id}`, {
      method: "DELETE",
    });
    if (state.conversation?.id === conversation.id) state.conversation = null;
    await loadConversations(true);
  } catch (error) {
    toast(errorMessage(error));
  }
}

function renderTranscript() {
  if (!transcript) return;
  clear(transcript);
  const entries = state.conversation?.transcript;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      append(
        transcript,
        renderMessage(document, {
          role: entry?.role,
          content: entry?.content,
          incomplete: entry?.incomplete === true,
        }),
      );
    }
  }
  if (chatEmpty) chatEmpty.hidden = Boolean(entries?.length);
}

async function selectConversation(id) {
  if (state.streaming) return;
  try {
    const conversation = await jsonRequest(`/api/conversations/${id}`);
    state.conversation = conversation;
    showView("chat");
    renderSidebar();
    renderTranscript();
    await loadProposals();
  } catch (error) {
    toast(errorMessage(error));
  }
}

function currentStream(context) {
  return isCurrentStream(context, state.activeStream, state.conversation?.id);
}

function updateToolActivity(context, text) {
  if (!currentStream(context) || !context.activityNode) return;
  setText(context.activityNode, text);
}

function finishToolActivity(context) {
  if (!currentStream(context) || !context.activityNode) return;
  setText(context.activityNode, summarizeToolActivity(context));
  context.activityNode.className = "text-sm opacity-60";
}

function createAssistantOutput(context) {
  context.assistantNode = renderAssistantMessage(document, "", false);
  const wrapper = document.createElement("section");
  wrapper.className = "space-y-2";
  context.activityNode = nodeWithText(
    "p",
    "text-sm opacity-60",
    "Assistant is working…",
  );
  context.activityNode.setAttribute("role", "status");
  context.activityNode.setAttribute("aria-live", "polite");
  append(wrapper, context.activityNode, context.assistantNode);
  context.recommendationNode = document.createElement("div");
  context.recommendationNode.className = "mt-3 grid gap-3";
  append(wrapper, context.recommendationNode);
  append(transcript, wrapper);
}

function updateAssistant(context, incomplete = false) {
  if (!context.assistantNode) return;
  const parent = context.assistantNode.parentNode;
  if (!parent) return;
  const replacement = renderAssistantMessage(
    document,
    context.assistantText,
    incomplete,
  );
  parent.replaceChild(replacement, context.assistantNode);
  context.assistantNode = replacement;
}

function addRecommendations(context, recommendations) {
  if (
    !currentStream(context) ||
    !context.recommendationNode ||
    !Array.isArray(recommendations)
  )
    return;
  for (const recommendation of recommendations) {
    append(
      context.recommendationNode,
      renderRecommendationCard(document, recommendation, {
        onAction: recommendationAction,
      }),
    );
  }
}

function handleStreamEvent(event, context) {
  if (
    !event ||
    typeof event.type !== "string" ||
    !currentStream(context) ||
    context.terminal
  )
    return;
  if (event.type === "text_delta" && typeof event.delta === "string") {
    context.assistantText += event.delta;
    updateAssistant(context, false);
  } else if (event.type === "tool_status") {
    updateToolActivity(context, recordToolStatus(context, event));
  } else if (event.type === "complete") {
    finishToolActivity(context);
    addRecommendations(context, event.recommendations);
    updateAssistant(context, event.incomplete === true);
    markStreamTerminal(context, event);
  } else if (event.type === "error") {
    finishToolActivity(context);
    updateAssistant(context, event.incomplete === true);
    append(
      transcript,
      nodeWithText(
        "p",
        "alert alert-error my-2",
        event.message || "Model turn failed",
      ),
    );
    markStreamTerminal(context, event);
  }
}

async function sendMessage(text) {
  if (!state.conversation?.id || state.streaming) return;
  const conversationId = state.conversation.id;
  const context = createStreamContext(conversationId);
  state.activeStream = context;
  state.streaming = true;
  setNavigationDisabled(true);
  renderSidebar();
  if (cancelTurn) cancelTurn.hidden = true;
  createAssistantOutput(context);
  try {
    await streamRequest(
      `/api/conversations/${conversationId}/messages`,
      { text },
      (event) => handleStreamEvent(event, context),
    );
    if (currentStream(context) && streamNeedsIncomplete(context)) {
      finishToolActivity(context);
      updateAssistant(context, true);
    }
    if (currentStream(context)) await loadProposals(conversationId);
  } catch (error) {
    if (currentStream(context)) {
      finishToolActivity(context);
      if (streamNeedsIncomplete(context)) updateAssistant(context, true);
      append(
        transcript,
        nodeWithText("p", "alert alert-error my-2", errorMessage(error)),
      );
    }
  } finally {
    if (state.activeStream === context) {
      state.activeStream = null;
      state.streaming = false;
      setNavigationDisabled(false);
      renderSidebar();
    }
    if (cancelTurn) cancelTurn.hidden = true;
  }
}

async function submitMessage(event) {
  event.preventDefault();
  const text = messageInput?.value?.trim() || "";
  if (!text) return;
  if (!state.conversation) {
    toast("Create or choose a conversation first.");
    return;
  }
  messageInput.value = "";
  if (chatEmpty) chatEmpty.hidden = true;
  append(transcript, renderMessage(document, { role: "user", content: text }));
  await sendMessage(text);
}

function queryLibrary() {
  const params = new URLSearchParams();
  const query = byId("library-query")?.value?.trim();
  const status = byId("library-status")?.value;
  const rating = byId("library-rating")?.value;
  const seriesId = byId("library-series")?.value;
  if (query) params.set("query", query);
  if (status) params.set("status", status);
  if (rating) params.set("rating", rating);
  if (seriesId) params.set("seriesId", seriesId);
  params.set("limit", "100");
  params.set("offset", "0");
  return params.toString();
}

async function loadSeries() {
  try {
    const page = await jsonRequest("/api/series?limit=100&offset=0");
    state.series = Array.isArray(page?.items) ? page.items : [];
    const select = byId("library-series");
    if (!select) return;
    const selected = select.value;
    clear(select);
    append(select, nodeWithText("option", null, "Any"));
    select.firstChild.value = "";
    for (const series of state.series) {
      const option = nodeWithText("option", null, series.name);
      option.value = String(series.id);
      append(select, option);
    }
    select.value = selected;
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function loadLibrary() {
  try {
    const page = await jsonRequest(`/api/books?${queryLibrary()}`);
    state.books = Array.isArray(page?.items) ? page.items : [];
    const target = byId("library-list");
    clear(target);
    append(
      target,
      renderLibrary(document, state.books, {
        onOpen: (book) => showBook(book.id),
      }),
    );
  } catch (error) {
    toast(errorMessage(error));
  }
}

function formField(form, label, name, value, type = "text") {
  const wrapper = document.createElement("label");
  wrapper.className = "form-control gap-1 text-sm";
  wrapper.appendChild(document.createTextNode(label));
  const input = document.createElement("input");
  input.className = "input input-bordered w-full";
  input.name = name;
  input.type = type;
  input.value = value == null ? "" : String(value);
  wrapper.appendChild(input);
  form.appendChild(wrapper);
  return input;
}

function selectField(form, label, name, value, choices) {
  const wrapper = document.createElement("label");
  wrapper.className = "form-control gap-1 text-sm";
  wrapper.appendChild(document.createTextNode(label));
  const select = document.createElement("select");
  select.className = "select select-bordered w-full";
  select.name = name;
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.appendChild(document.createTextNode(choice.label));
    if (choice.value === String(value ?? "")) option.selected = true;
    select.appendChild(option);
  }
  wrapper.appendChild(select);
  form.appendChild(wrapper);
  return select;
}

function renderBookEditor(book) {
  const form = document.createElement("form");
  form.className = "mt-4 grid gap-3";
  formField(form, "Title", "title", book.title);
  formField(form, "Author", "author", book.author);
  formField(
    form,
    "Publication year",
    "publicationYear",
    book.publicationYear,
    "number",
  );
  formField(form, "Cover URL", "coverUrl", book.coverUrl);
  formField(form, "Series position", "seriesPosition", book.seriesPosition);
  selectField(form, "Series", "seriesId", book.seriesId, [
    { value: "", label: "None" },
    ...state.series.map((series) => ({
      value: String(series.id),
      label: series.name,
    })),
  ]);
  selectField(form, "Status", "status", book.status, [
    { value: "recommended", label: "Recommended" },
    { value: "interested", label: "Interested" },
    { value: "reading", label: "Reading" },
    { value: "read", label: "Read" },
    { value: "abandoned", label: "Abandoned" },
    { value: "not_interested", label: "Not interested" },
  ]);
  selectField(form, "Rating", "rating", book.rating, [
    { value: "", label: "No rating" },
    ...[1, 2, 3, 4, 5].map((rating) => ({
      value: String(rating),
      label: String(rating),
    })),
  ]);
  const identifierField = document.createElement("label");
  identifierField.className = "form-control gap-1 text-sm";
  identifierField.appendChild(
    document.createTextNode(
      "Identifiers (scheme | value | source, one per line)",
    ),
  );
  const identifiers = document.createElement("textarea");
  identifiers.name = "identifiers";
  identifiers.className = "textarea textarea-bordered w-full";
  identifiers.rows = 4;
  identifiers.value = (book.identifiers || [])
    .map(
      (identifier) =>
        `${identifier.scheme} | ${identifier.value} | ${identifier.source}`,
    )
    .join("\n");
  identifierField.appendChild(identifiers);
  form.appendChild(identifierField);
  const save = nodeWithText("button", "btn btn-primary", "Save book");
  save.type = "submit";
  form.appendChild(save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const value = (name) => String(data.get(name) || "").trim();
    const year = value("publicationYear");
    const seriesId = value("seriesId");
    const rating = value("rating");
    try {
      const identifiers = value("identifiers")
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .map((line) => {
          const [scheme, identifierValue, ...sourceParts] = line
            .split("|")
            .map((part) => part.trim());
          const source = sourceParts.join("|");
          if (!scheme || !identifierValue || !source) {
            throw new Error("Each identifier must use scheme | value | source");
          }
          return { scheme, value: identifierValue, source };
        });
      const updated = await jsonRequest(`/api/books/${book.id}`, {
        method: "PATCH",
        body: {
          title: value("title"),
          author: value("author"),
          publicationYear: year ? Number(year) : null,
          coverUrl: value("coverUrl") || null,
          seriesId: seriesId ? Number(seriesId) : null,
          seriesPosition: value("seriesPosition") || null,
          status: value("status"),
          rating: rating ? Number(rating) : null,
          identifiers,
        },
      });
      await showBook(updated.id);
      await loadLibrary();
    } catch (error) {
      toast(errorMessage(error));
    }
  });
  return form;
}

async function editNote(note) {
  const value = window.prompt("Note", note.note);
  if (value == null) return;
  try {
    await jsonRequest(`/api/books/${note.bookId}/notes/${note.id}`, {
      method: "PATCH",
      body: { note: value },
    });
    await showBook(note.bookId);
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function deleteNote(note) {
  if (!window.confirm("Delete this note?")) return;
  try {
    await jsonRequest(`/api/books/${note.bookId}/notes/${note.id}`, {
      method: "DELETE",
    });
    await showBook(note.bookId);
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function recommendationAction(action, recommendation) {
  if (action === "open")
    return showBook(recommendation.bookId || recommendation.book?.id);
  const statuses = {
    interested: "interested",
    reading: "reading",
    not_interested: "not_interested",
  };
  const status = statuses[action];
  if (!status) return;
  const bookId = recommendation.bookId || recommendation.book?.id;
  if (!bookId) return;
  try {
    await jsonRequest(`/api/books/${bookId}`, {
      method: "PATCH",
      body: { status },
    });
    await showBook(bookId);
    if (state.view === "library") await loadLibrary();
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function showBook(bookOrId) {
  const id = typeof bookOrId === "object" ? bookOrId.id : bookOrId;
  if (!id) return;
  try {
    const book =
      typeof bookOrId === "object" && bookOrId.notes
        ? bookOrId
        : await jsonRequest(`/api/books/${id}`);
    clear(drawerContent);
    append(
      drawerContent,
      renderBookDetails(document, book, {
        onEdit: () => append(drawerContent, renderBookEditor(book)),
        onEditNote: editNote,
        onDeleteNote: deleteNote,
      }),
    );
    if (Array.isArray(book.identifiers) && book.identifiers.length) {
      const identifiers = document.createElement("section");
      identifiers.className = "card bg-base-200 p-4";
      append(identifiers, nodeWithText("h3", "card-title", "Identifiers"));
      for (const identifier of book.identifiers) {
        append(
          identifiers,
          nodeWithText("p", null, `${identifier.scheme}: ${identifier.value}`),
        );
      }
      append(drawerContent, identifiers);
    }
    if (Array.isArray(book.recommendations) && book.recommendations.length) {
      const recommendations = document.createElement("section");
      recommendations.className = "grid gap-3";
      append(
        recommendations,
        nodeWithText("h3", "text-lg font-semibold", "Recommendation history"),
      );
      for (const recommendation of book.recommendations) {
        append(
          recommendations,
          renderRecommendationCard(
            document,
            { ...recommendation, book },
            { onAction: recommendationAction },
          ),
        );
      }
      append(drawerContent, recommendations);
    }
    openDrawer();
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function acceptProposal(proposal, edit = false) {
  let value = proposal.value;
  if (edit) {
    const entered = window.prompt(
      "Edit proposed value",
      value == null ? "" : String(value),
    );
    if (entered == null) return;
    value = proposal.kind === "rating" ? Number(entered) : entered;
  }
  try {
    await jsonRequest(
      `/api/conversations/${state.conversation.id}/proposals/${encodeURIComponent(proposal.proposalId)}/accept`,
      {
        method: "POST",
        body: { value },
      },
    );
    await loadProposals();
    await loadLibrary();
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function rejectProposal(proposal) {
  try {
    await jsonRequest(
      `/api/conversations/${state.conversation.id}/proposals/${encodeURIComponent(proposal.proposalId)}/reject`,
      {
        method: "POST",
        body: {},
      },
    );
    await loadProposals();
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function loadProposals(conversationId = state.conversation?.id) {
  if (!drawerContent) return;
  if (!conversationId) {
    clear(drawerContent);
    append(
      drawerContent,
      nodeWithText(
        "p",
        "py-8 text-center opacity-60",
        "Select a book or pending change.",
      ),
    );
    return;
  }
  try {
    const proposals = await jsonRequest(
      `/api/conversations/${conversationId}/proposals`,
    );
    clear(drawerContent);
    if (!Array.isArray(proposals) || !proposals.length) {
      append(
        drawerContent,
        nodeWithText("p", "py-8 text-center opacity-60", "No pending changes."),
      );
      return;
    }
    append(
      drawerContent,
      nodeWithText("h3", "text-lg font-semibold", "Pending changes"),
    );
    for (const proposal of proposals) {
      append(
        drawerContent,
        renderProposal(document, proposal, {
          onAccept: (item) => acceptProposal(item),
          onEdit: (item) => acceptProposal(item, true),
          onReject: rejectProposal,
        }),
      );
    }
  } catch (error) {
    toast(errorMessage(error));
  }
}

function wire() {
  byId("new-conversation")?.addEventListener("click", createConversation);
  byId("library-link")?.addEventListener("click", async () => {
    if (state.streaming) return;
    showView("library");
    await loadSeries();
    await loadLibrary();
  });
  byId("open-drawer")?.addEventListener("click", openDrawer);
  byId("close-drawer")?.addEventListener("click", () => drawer?.close());
  byId("library-filters")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await loadLibrary();
  });
  messageForm?.addEventListener("submit", submitMessage);
  messageInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey) return;
    event.preventDefault();
    messageForm?.requestSubmit();
  });
  showView("chat");
  void loadConversations();
}

wire();
