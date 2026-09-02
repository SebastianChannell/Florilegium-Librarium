const searchForm = requiredElement("search-form");
const searchInput = requiredElement("search-input");
const sortSelect = requiredElement("sort-select");
const resultCount = requiredElement("result-count");
const statusMessage = requiredElement("status-message");
const libraryList = requiredElement("library-list");
const categoryList = requiredElement("category-list");
const showAllCategories = requiredElement("show-all-categories");
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

      return normalizeSearchValue(`${book.title} ${book.author} ${book.collection} ${book.category}`).includes(query);
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
      count.textContent = String(counts.get(option.dataset.category) ?? 0);
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

function createBookRow(book) {
  const item = document.createElement("li");
  item.className = "book-item";

  const link = document.createElement("a");
  link.className = "book-link";
  link.href = book.readerUrl;
  link.setAttribute("aria-label", `Read ${book.title}`);

  const details = document.createElement("span");
  details.className = "book-details";

  const title = document.createElement("span");
  title.className = "book-title";
  title.textContent = book.title;
  details.append(title);

  if (book.collection && book.collection !== "Library") {
    const collection = document.createElement("span");
    collection.className = "book-collection";
    collection.textContent = book.collection;
    details.append(collection);
  }

  const action = document.createElement("span");
  action.className = "book-action";

  const actionLabel = document.createElement("span");
  actionLabel.textContent = "Read";

  const actionArrow = document.createElement("span");
  actionArrow.setAttribute("aria-hidden", "true");
  actionArrow.textContent = "→";

  action.append(actionLabel, actionArrow);
  link.append(details, action);
  item.append(link);
  return item;
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
