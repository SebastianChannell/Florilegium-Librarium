const elements = {
  sidebar: document.getElementById("browse-sidebar"),
  toggle: document.getElementById("sidebar-toggle"),
  close: document.getElementById("sidebar-close"),
  backdrop: document.getElementById("sidebar-backdrop"),
  searchForm: document.getElementById("search-form"),
  searchInput: document.getElementById("search-input"),
  clearSearch: document.getElementById("clear-search"),
  count: document.getElementById("result-count"),
  refresh: document.getElementById("refresh-catalogue"),
  reseed: document.getElementById("reseed-catalogue"),
  refreshSubmit: document.getElementById("refresh-auth-submit"),
  refreshForm: document.getElementById("refresh-auth-form"),
  refreshKeyInput: document.getElementById("refresh-key-input"),
  refreshCancel: document.getElementById("refresh-auth-cancel"),
  status: document.getElementById("status-message"),
  results: document.getElementById("results"),
};

const mainCategories = ["Liturgia", "Theologia", "Spiritualia", "Preces", "Auctores"];
const titleCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const state = {
  books: [],
  query: new URLSearchParams(location.search).get("q") || "",
};
const expandedGroups = new Set();
let focusBeforeSidebar = null;
let manualRefreshKey = "";
let pendingMaintenanceAction = "import";

function openSidebar(focusSearch = false) {
  if (!document.body.classList.contains("sidebar-open")) {
    focusBeforeSidebar = document.activeElement;
    document.body.classList.add("sidebar-open");
    elements.sidebar.inert = false;
    elements.sidebar.setAttribute("aria-hidden", "false");
    elements.toggle.setAttribute("aria-expanded", "true");
  }
  (focusSearch ? elements.searchInput : elements.close).focus({ preventScroll: true });
}

function closeSidebar() {
  if (!document.body.classList.contains("sidebar-open")) return;
  document.body.classList.remove("sidebar-open");
  elements.sidebar.inert = true;
  elements.sidebar.setAttribute("aria-hidden", "true");
  elements.toggle.setAttribute("aria-expanded", "false");
  const target = focusBeforeSidebar && focusBeforeSidebar.isConnected
    ? focusBeforeSidebar : elements.toggle;
  target.focus({ preventScroll: true });
  focusBeforeSidebar = null;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function sortedBooks(books) {
  return [...books].sort((a, b) => titleCollator.compare(a.title, b.title));
}

function searchText(book) {
  return [
    book.title, book.author, book.category, book.collection,
    book.language, ...(Array.isArray(book.subjects) ? book.subjects : []),
  ].join(" ");
}

function bookList(books) {
  const list = document.createElement("ul");
  list.className = "book-list";

  for (const book of books) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "book-link";
    link.href = book.readerUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = book.title;
    link.setAttribute("aria-label", "Open " + book.title + " in a new tab");
    if (book.author) link.title = book.author;
    item.append(link);
    list.append(item);
  }
  return list;
}

function categoryGroup(name, books) {
  const group = document.createElement("details");
  group.className = "category-group";
  group.open = expandedGroups.has(name);
  group.addEventListener("toggle", () => {
    if (group.open) expandedGroups.add(name);
    else expandedGroups.delete(name);
  });

  const heading = document.createElement("summary");
  const label = document.createElement("span");
  label.className = "category-name";
  label.textContent = name;
  const count = document.createElement("span");
  count.className = "category-count";
  count.textContent = String(books.length);
  const chevron = document.createElement("span");
  chevron.className = "category-chevron";
  chevron.textContent = "›";
  chevron.setAttribute("aria-hidden", "true");
  heading.append(label, count, chevron);
  group.append(heading, bookList(books));
  return group;
}

function renderIndex() {
  const query = normalize(state.query);
  elements.clearSearch.hidden = !state.query;
  elements.results.replaceChildren();
  elements.status.hidden = true;

  if (query) {
    const matches = sortedBooks(state.books.filter((book) => normalize(searchText(book)).includes(query)));
    elements.count.textContent = matches.length + (matches.length === 1 ? " book found" : " books found");
    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "empty-message";
      empty.textContent = "No matching books.";
      elements.results.append(empty);
      return;
    }

    const label = document.createElement("p");
    label.className = "search-results-label";
    label.textContent = "Results";
    const list = bookList(matches);
    list.classList.add("search-results");
    elements.results.append(label, list);
    return;
  }

  elements.count.textContent = state.books.length + (state.books.length === 1 ? " book" : " books");
  const grouped = new Map();
  for (const book of state.books) {
    const category = book.category.trim() || "Alia";
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(book);
  }

  // Only the established classifications appear in the sidebar. Unclassified
  // books remain accessible through Omnes and search, without an extra tab.
  const categories = mainCategories;
  const fragment = document.createDocumentFragment();
  fragment.append(categoryGroup("Omnes", sortedBooks(state.books)));
  for (const category of categories) {
    fragment.append(categoryGroup(category, sortedBooks(grouped.get(category) || [])));
  }
  elements.results.append(fragment);
}

function updateSearch() {
  state.query = elements.searchInput.value.trim();
  const url = new URL(location.href);
  if (state.query) url.searchParams.set("q", state.query);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
  renderIndex();
}

function validBook(book) {
  if (!book || typeof book.title !== "string" ||
      typeof book.category !== "string" || typeof book.readerUrl !== "string") return false;
  try {
    const url = new URL(book.readerUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function loadBooks() {
  elements.count.textContent = "Loading books…";
  elements.results.replaceChildren();
  elements.status.hidden = true;
  try {
    const response = await fetch("/api/books", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error("Catalogue request failed: " + response.status);
    const data = await response.json();
    if (!data || !Array.isArray(data.books)) throw new Error("Invalid catalogue response");
    state.books = data.books.filter(validBook);
    renderIndex();
  } catch (error) {
    console.error("Could not load Librarium", error);
    elements.count.textContent = "Catalogue unavailable";
    elements.status.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "Books could not be loaded.";
    const retry = document.createElement("button");
    retry.className = "retry-button";
    retry.type = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", loadBooks);
    elements.status.append(message, retry);
    elements.status.hidden = false;
  } finally {
    // Both controls start disabled in HTML; enable them even if the current
    // R2 snapshot is unavailable, so Rebuild index can repair the catalog.
    elements.refresh.hidden = false;
    elements.refresh.disabled = false;
    elements.reseed.hidden = false;
    elements.reseed.disabled = false;
  }
}

async function runManualImport(action = "import") {
  if (!manualRefreshKey || elements.refresh.disabled || elements.reseed.disabled) return;
  elements.refresh.disabled = true;
  elements.reseed.disabled = true;
  const reseedOnly = action === "reseed";
  const actionButton = reseedOnly ? elements.reseed : elements.refresh;
  actionButton.textContent = reseedOnly ? "Rebuilding…" : "Importing…";
  elements.status.textContent = reseedOnly
    ? "Rebuilding the catalog snapshot from Supabase (no PDF scan)…"
    : "Checking R2 and importing changed PDFs into Supabase…";
  elements.status.hidden = false;

  try {
    const response = await fetch(reseedOnly ? "/api/reseed" : "/api/refresh", {
      method: "POST",
      headers: { Accept: "application/json", Authorization: "Bearer " + manualRefreshKey },
      cache: "no-store",
    });
    const data = await response.json();
    if (response.status === 401) {
      manualRefreshKey = "";
      elements.refreshForm.hidden = false;
      elements.refreshKeyInput.focus();
      throw new Error(data.error || "Incorrect manual import key. It is not your Supabase secret.");
    }
    if (!response.ok) {
      const code = data.code ? " [" + data.code + "]" : "";
      throw new Error((data.error || "Catalog update failed (" + response.status + ").") + code);
    }
    if (!Array.isArray(data.books)) throw new Error("Invalid catalog response.");
    state.books = data.books.filter(validBook);
    renderIndex();
    if (reseedOnly) {
      const total = data.snapshot?.publishedBooks ?? state.books.length;
      elements.status.textContent = "Index rebuilt from Supabase: " + total +
        " published book" + (total === 1 ? "" : "s") + ".";
    } else {
      const imported = data.imported;
      let message = "Scanned " + imported.scanned + " PDF" +
        (imported.scanned === 1 ? "" : "s") + " in R2/pdfs/. " +
        imported.created + " new Draft" + (imported.created === 1 ? "" : "s") +
        " created in Supabase, " + imported.updated + " updated, " +
        imported.unchanged + " unchanged.";
      if (imported.created > 0) {
        message += " Review new books in Supabase → books → status = Draft. " +
          "They will NOT appear publicly until you mark them Published.";
      }
      if (imported.failed > 0) {
        message += " " + imported.failed + " FAILED.";
        if (Array.isArray(imported.failures)) {
          message += " " + imported.failures.map(item =>
            item.key + ": " + item.reason).join("; ") + ".";
        }
      }
      if (imported.deferred > 0) {
        message += " " + imported.deferred + " deferred (five changed PDFs per run).";
        if (Array.isArray(imported.deferredKeys) && imported.deferredKeys.length) {
          message += " Next: " + imported.deferredKeys.slice(0, 5).join(", ") + ".";
        }
        message += " Run Import & refresh again after the one-minute cooldown.";
      }
      if (imported.scanned === 0) {
        message += " No PDFs found: verify the R2 object keys begin with pdfs/ and end with .pdf.";
      } else if (!imported.created && !imported.updated && !imported.failed && !imported.deferred) {
        message += " No new PDF imports were needed. If an upload is missing, check its R2 key is under pdfs/ with a .pdf extension.";
      }
      elements.status.textContent = message;
    }
    elements.status.hidden = false;
  } catch (error) {
    console.error("Manual Librarium maintenance failed", error);
    elements.status.textContent = error.message || "Catalog operation failed. Existing index retained.";
    elements.status.hidden = false;
  } finally {
    elements.refresh.disabled = false;
    elements.reseed.disabled = false;
    elements.refresh.textContent = "Import & refresh";
    elements.reseed.textContent = "Rebuild index";
  }
}

function selectMaintenanceAction(action) {
  pendingMaintenanceAction = action;
  if (!manualRefreshKey) {
    elements.refreshSubmit.textContent = action === "reseed" ? "Rebuild index" : "Import now";
    elements.refreshForm.hidden = false;
    elements.refreshKeyInput.focus();
    return;
  }
  void runManualImport(action);
}

elements.refresh.addEventListener("click", () => selectMaintenanceAction("import"));
elements.reseed.addEventListener("click", () => selectMaintenanceAction("reseed"));
elements.refreshForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const key = elements.refreshKeyInput.value.trim();
  if (!key) return;
  manualRefreshKey = key; // In-memory only: never write to storage or URLs.
  elements.refreshKeyInput.value = "";
  elements.refreshForm.hidden = true;
  void runManualImport(pendingMaintenanceAction);
});
elements.refreshCancel.addEventListener("click", () => {
  elements.refreshKeyInput.value = "";
  elements.refreshForm.hidden = true;
  elements.refresh.focus();
});

elements.searchInput.value = state.query;
elements.searchForm.addEventListener("submit", (event) => event.preventDefault());
elements.searchInput.addEventListener("input", updateSearch);
elements.clearSearch.addEventListener("click", () => {
  elements.searchInput.value = "";
  updateSearch();
  elements.searchInput.focus();
});
elements.toggle.addEventListener("click", () => openSidebar(true));
elements.close.addEventListener("click", closeSidebar);
elements.backdrop.addEventListener("click", closeSidebar);

window.addEventListener("popstate", () => {
  state.query = new URLSearchParams(location.search).get("q") || "";
  elements.searchInput.value = state.query;
  renderIndex();
});

document.addEventListener("keydown", (event) => {
  const isOpen = document.body.classList.contains("sidebar-open");
  if (event.key === "Escape" && isOpen) {
    event.preventDefault();
    closeSidebar();
    return;
  }
  if (event.key === "Tab" && isOpen) {
    const focusable = [...elements.sidebar.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    )].filter((element) => element.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !elements.sidebar.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !elements.sidebar.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
    return;
  }

  const editable = document.activeElement && document.activeElement.matches('input, textarea, [contenteditable="true"]');
  if (event.key === "/" && !event.altKey && !event.ctrlKey && !event.metaKey && !editable) {
    event.preventDefault();
    openSidebar(true);
  }
});

// The sidebar is the entire interface: open it immediately to avoid a blank landing screen.
openSidebar();
void loadBooks();
