const searchForm = requiredElement("search-form");
const searchInput = requiredElement("search-input");
const sortSelect = requiredElement("sort-select");
const resultCount = requiredElement("result-count");
const statusMessage = requiredElement("status-message");
const libraryList = requiredElement("library-list");
const categoryList = requiredElement("category-list");
const showAllCategories = requiredElement("show-all-categories");
const gridViewButton = requiredElement("grid-view");
const listViewButton = requiredElement("list-view");
const catalogueSection = requiredElement("catalogue-view");
const detailSection = requiredElement("book-detail");
const backToBooks = requiredElement("back-to-books");
const detailCover = requiredElement("detail-cover");
const detailCategory = requiredElement("detail-category");
const detailTitle = requiredElement("detail-title");
const detailAuthor = requiredElement("detail-author");
const detailMetadata = requiredElement("detail-metadata");
const detailReader = requiredElement("detail-reader");
const categoryOptions = [...categoryList.querySelectorAll("[data-category]")];

const titleCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

const state = {
  books: [],
  query: new URLSearchParams(window.location.search).get("q")?.trim() ?? "",
  category: new URLSearchParams(window.location.search).get("category")?.trim() ?? "",
  sort: "title",
  view: "grid",
};

searchInput.value = state.query;

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  searchInput.blur();
});

searchInput.addEventListener("input", () => {
  state.query = searchInput.value.trim();
  updateAddressBar();
  renderBooks();
});

categoryList.addEventListener("click", (event) => {
  const option = event.target.closest("[data-category]");
  if (!option) {
    return;
  }

  state.category = option.dataset.category ?? "";
  updateAddressBar();
  renderBooks();
});

showAllCategories.addEventListener("click", () => {
  state.category = "";
  updateAddressBar();
  renderBooks();
});

sortSelect.addEventListener("change", () => {
  state.sort = sortSelect.value === "recent" ? "recent" : "title";
  renderBooks();
});

gridViewButton.addEventListener("click", () => setView("grid"));
listViewButton.addEventListener("click", () => setView("list"));

backToBooks.addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.searchParams.delete("book");
  window.history.pushState(null, "", url);
  renderCurrentView();
});

window.addEventListener("popstate", () => {
  const params = new URLSearchParams(window.location.search);
  state.query = params.get("q")?.trim() ?? "";
  state.category = params.get("category")?.trim() ?? "";
  searchInput.value = state.query;
  renderBooks();
  renderCurrentView();
});

await loadBooks();

async function loadBooks() {
  setLoadingState();

  try {
    const response = await fetch("/api/books", {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Library request failed with ${response.status}`);
    }

    const payload = await response.json();
    if (!payload || !Array.isArray(payload.books)) {
      throw new Error("Library response was not valid");
    }

    state.books = payload.books.filter(isBook);
    renderCategoryCounts();
    renderBooks();
    renderCurrentView();
  } catch (error) {
    console.error("Could not load Librarium", error);
    renderError();
  }
}

function renderBooks() {
  const query = normalizeSearchValue(state.query);
  const visibleBooks = state.books
    .filter((book) => {
      if (state.category && book.category !== state.category) {
        return false;
      }

      if (!query) {
        return true;
      }

      return normalizeSearchValue(`${book.title} ${book.author} ${book.collection} ${book.category} ${(book.subjects ?? []).join(" ")} ${book.language ?? ""}`).includes(query);
    })
    .sort((left, right) => {
      if (state.sort === "recent") {
        const dateDifference = Date.parse(right.uploaded) - Date.parse(left.uploaded);
        return dateDifference || titleCollator.compare(left.title, right.title);
      }

      return titleCollator.compare(left.title, right.title);
    });

  libraryList.replaceChildren();
  const fragment = document.createDocumentFragment();

  for (const book of visibleBooks) {
    fragment.append(createBookRow(book));
  }

  libraryList.append(fragment);
  libraryList.dataset.view = state.view;
  resultCount.textContent = resultCountText(
    visibleBooks.length,
    state.books.length,
    Boolean(query || state.category),
  );
  renderCategorySelection();

  if (visibleBooks.length === 0) {
    renderEmptyState(Boolean(query));
    return;
  }

  statusMessage.hidden = true;
  libraryList.hidden = false;
}

function renderCategoryCounts() {
  const counts = new Map();
  for (const book of state.books) {
    counts.set(book.category, (counts.get(book.category) ?? 0) + 1);
  }

  for (const option of categoryOptions) {
    const count = option.querySelector(".category-count");
    if (count) {
      count.textContent = String(option.dataset.category ? (counts.get(option.dataset.category) ?? 0) : state.books.length);
    }
  }
}

function renderCategorySelection() {
  for (const option of categoryOptions) {
    option.setAttribute(
      "aria-pressed",
      String(option.dataset.category === state.category),
    );
  }

  showAllCategories.hidden = !state.category;
}

function setView(view) {
  state.view = view === "list" ? "list" : "grid";
  libraryList.dataset.view = state.view;
  gridViewButton.setAttribute("aria-pressed", String(state.view === "grid"));
  listViewButton.setAttribute("aria-pressed", String(state.view === "list"));
}

function bookPageUrl(slug) {
  const url = new URL(window.location.href);
  url.searchParams.set("book", slug);
  return `${url.pathname}${url.search}${url.hash}`;
}

function createBookThumbnail(book, isDetail = false) {
  const frame = document.createElement("span");
  frame.className = "book-thumbnail";

  const placeholder = document.createElement("span");
  placeholder.className = "thumbnail-placeholder";
  placeholder.setAttribute("aria-hidden", "true");

  const mark = document.createElement("span");
  mark.className = "placeholder-mark";
  mark.textContent = "✠";

  const label = document.createElement("span");
  label.className = "placeholder-title";
  label.textContent = book.title;
  placeholder.append(mark, label);

  if (typeof book.coverUrl === "string" && book.coverUrl.trim()) {
    const image = document.createElement("img");
    image.src = book.coverUrl;
    image.alt = isDetail ? `Title page of ${book.title}` : "";
    image.loading = isDetail ? "eager" : "lazy";
    image.decoding = "async";
    placeholder.hidden = true;
    image.addEventListener("error", () => {
      image.remove();
      placeholder.hidden = false;
    });
    frame.append(image);
  }

  frame.append(placeholder);
  return frame;
}

function createBookRow(book) {
  const item = document.createElement("li");
  item.className = "book-item";

  const link = document.createElement("a");
  link.className = "book-link";
  link.href = bookPageUrl(book.slug);
  link.setAttribute("aria-label", `View ${book.title}, by ${book.author || "unknown author"}`);
  link.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    openBookDetail(book);
  });

  const details = document.createElement("span");
  details.className = "book-details";

  const title = document.createElement("span");
  title.className = "book-title";
  title.textContent = book.title;
  details.append(title);

  if (book.author) {
    const author = document.createElement("span");
    author.className = "book-author";
    author.textContent = book.author;
    details.append(author);
  }

  const classification = document.createElement("span");
  classification.className = "book-collection";
  classification.textContent = book.category;
  details.append(classification);

  link.append(createBookThumbnail(book), details);
  item.append(link);
  return item;
}

function openBookDetail(book) {
  const url = new URL(window.location.href);
  url.searchParams.set("book", book.slug);
  window.history.pushState(null, "", url);
  renderCurrentView();
  window.scrollTo({ top: 0, behavior: "instant" });
  backToBooks.focus({ preventScroll: true });
}

function appendDetailField(label, value) {
  if (!value) return;
  const row = document.createElement("div");
  row.className = "detail-metadata-row";
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = String(value);
  row.append(term, description);
  detailMetadata.append(row);
}

function renderCurrentView() {
  const slug = new URLSearchParams(window.location.search).get("book");
  const book = slug && state.books.find((entry) => entry.slug === slug);
  if (!book) {
    detailSection.hidden = true;
    catalogueSection.hidden = false;
    return;
  }

  detailCategory.textContent = book.category;
  detailTitle.textContent = book.title;
  detailAuthor.textContent = book.author || "Author not listed";
  detailCover.replaceChildren(createBookThumbnail(book, true));
  detailMetadata.replaceChildren();
  appendDetailField("Classification", book.category);
  appendDetailField("Language", book.language);
  appendDetailField("Pages", book.pages);
  appendDetailField("Subjects", Array.isArray(book.subjects) ? book.subjects.join(", ") : "");
  appendDetailField("Format", "Digital facsimile · PDF");
  detailReader.href = book.readerUrl;

  catalogueSection.hidden = true;
  detailSection.hidden = false;
}

function renderEmptyState(isSearch) {
  libraryList.hidden = true;
  statusMessage.replaceChildren();

  const message = document.createElement("p");
  message.textContent = isSearch
    ? "No books match this search."
    : "No PDF books were found in the library.";
  statusMessage.append(message);
  statusMessage.hidden = false;
}

function renderError() {
  libraryList.hidden = true;
  resultCount.textContent = "Library unavailable";
  statusMessage.replaceChildren();

  const message = document.createElement("p");
  message.textContent = "The library could not be opened just now.";

  const retry = document.createElement("button");
  retry.className = "retry-button";
  retry.type = "button";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => {
    void loadBooks();
  });

  statusMessage.append(message, retry);
  statusMessage.hidden = false;
}

function setLoadingState() {
  libraryList.hidden = true;
  resultCount.textContent = "Loading books…";
  statusMessage.replaceChildren();

  const mark = document.createElement("span");
  mark.className = "loading-mark";
  mark.setAttribute("aria-hidden", "true");

  const message = document.createElement("span");
  message.textContent = "Opening the library…";
  statusMessage.append(mark, message);
  statusMessage.hidden = false;
}

function resultCountText(visible, total, isSearch) {
  const noun = visible === 1 ? "book" : "books";
  return isSearch ? `${visible} of ${total} ${noun}` : `${visible} ${noun}`;
}

function normalizeSearchValue(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function updateAddressBar() {
  const url = new URL(window.location.href);
  if (state.query) {
    url.searchParams.set("q", state.query);
  } else {
    url.searchParams.delete("q");
  }
  if (state.category) {
    url.searchParams.set("category", state.category);
  } else {
    url.searchParams.delete("category");
  }
  window.history.replaceState(null, "", url);
}

function isBook(value) {
  return (
    value &&
    typeof value.key === "string" &&
    typeof value.slug === "string" &&
    typeof value.title === "string" &&
    typeof value.author === "string" &&
    typeof value.category === "string" &&
    typeof value.collection === "string" &&
    typeof value.readerUrl === "string" &&
    typeof value.uploaded === "string"
  );
}

function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element;
}
