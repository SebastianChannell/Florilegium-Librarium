export interface CatalogBook {
  slug: string;
  title: string;
  author: string;
  classification: string;
  dateAdded: string;
}

// Airtable is the canonical catalogue. This checked-in snapshot lets the Worker
// serve that metadata without exposing an Airtable credential in the browser.
export const BOOK_CATALOG: readonly CatalogBook[] = [
  {
    slug: "ancora-de-salvacion",
    title: "Áncora de Salvación",
    author: "Fr. José Mach, S.J.",
    classification: "Spiritualia",
    dateAdded: "2026-08-22",
  },
  {
    slug: "big-book-of-little-offices",
    title: "A Big Book of Little Offices",
    author: "Little Office Guild",
    classification: "Liturgia",
    dateAdded: "2026-07-11",
  },
  {
    slug: "catechism-of-saint-pius-x",
    title: "Catechism of Saint Pius X",
    author: "St. Pius X",
    classification: "Theologia",
    dateAdded: "2026-08-17",
  },
  {
    slug: "catecismo-mayor-de-san-pio-x",
    title: "Catecismo Mayor de San Pío X",
    author: "St. Pius X",
    classification: "Theologia",
    dateAdded: "2026-08-24",
  },
  {
    slug: "examination-of-conscience-for-adults",
    title: "Examination of Conscience for Adults",
    author: "Fr. Donald F. Miller, C.Ss.R.",
    classification: "Spiritualia",
    dateAdded: "2026-08-03",
  },
  {
    slug: "examination-of-conscience-for-married-couples",
    title: "An Examination of Conscience for Married Couples",
    author: "Fr. Edwin C. Haungs, S.J.",
    classification: "Spiritualia",
    dateAdded: "2026-08-14",
  },
  {
    slug: "introduction-to-the-devout-life",
    title: "Introduction to the Devout Life",
    author: "St. Francis de Sales",
    classification: "Spiritualia",
    dateAdded: "2026-07-20",
  },
  {
    slug: "liber-antiphonarius-1960",
    title: "Liber Antiphonarius (1949, updated through 1960)",
    author: "Benedictines of Solesmes",
    classification: "Liturgia",
    dateAdded: "2026-07-11",
  },
  {
    slug: "liber-usualis-1961",
    title: "The Liber Usualis (1961)",
    author: "Benedictines of Solesmes",
    classification: "Liturgia",
    dateAdded: "2026-07-11",
  },
  {
    slug: "manual-of-the-purgatorian-society",
    title: "Manual of the Purgatorian Society",
    author: "Purgatorian Society",
    classification: "Spiritualia",
    dateAdded: "2026-07-11",
  },
  {
    slug: "miniature-lives-of-the-saints-vol-1",
    title: "Miniature Lives of the Saints, Vol. I",
    author: "Fr. Henry Sebastian Bowden",
    classification: "Spiritualia",
    dateAdded: "2026-08-14",
  },
  {
    slug: "miniature-lives-of-the-saints-vol-2",
    title: "Miniature Lives of the Saints, Vol. II",
    author: "Fr. Henry Sebastian Bowden",
    classification: "Spiritualia",
    dateAdded: "2026-08-14",
  },
  {
    slug: "misal-diario-y-devocionario-1957",
    title: "Misal Diario y Devocionario",
    author: "Fr. Luis Ribera, C.M.F.",
    classification: "Liturgia",
    dateAdded: "2026-08-27",
  },
  {
    slug: "my-prayer-book",
    title: "My Prayer-Book",
    author: "Fr. F. X. Lasance",
    classification: "Spiritualia",
    dateAdded: "2026-07-11",
  },
  {
    slug: "prayer-book-for-religious",
    title: "Prayer-Book for Religious",
    author: "Fr. F. X. Lasance",
    classification: "Spiritualia",
    dateAdded: "2026-07-11",
  },
  {
    slug: "scruples-and-their-treatment",
    title: "Scruples and Their Treatment",
    author: "Fr. William Doyle, S.J.",
    classification: "Spiritualia",
    dateAdded: "2026-08-29",
  },
  {
    slug: "sermons-of-st-bernard-on-advent-and-christmas",
    title: "Sermons of St. Bernard on Advent and Christmas",
    author: "St. Bernard of Clairvaux",
    classification: "Spiritualia",
    dateAdded: "2026-08-14",
  },
  {
    slug: "the-difficult-commandment",
    title: "The Difficult Commandment",
    author: "Fr. C. C. Martindale, S.J.",
    classification: "Spiritualia",
    dateAdded: "2026-07-11",
  },
  {
    slug: "the-hymns-of-the-breviary-and-missal",
    title: "The Hymns of the Breviary and Missal",
    author: "Fr. Matthew Britt, O.S.B.",
    classification: "Liturgia",
    dateAdded: "2026-08-07",
  },
  {
    slug: "the-prisoner-of-love",
    title: "The Prisoner of Love",
    author: "Fr. F. X. Lasance",
    classification: "Spiritualia",
    dateAdded: "2026-07-11",
  },
  {
    slug: "victories-of-the-martyrs",
    title: "Victories of the Martyrs",
    author: "St. Alphonsus Liguori",
    classification: "Spiritualia",
    dateAdded: "2026-08-14",
  },
  {
    slug: "with-god",
    title: "With God",
    author: "Fr. F. X. Lasance",
    classification: "Spiritualia",
    dateAdded: "2026-07-10",
  },
  {
    slug: "young-mans-guide",
    title: "The Young Man's Guide",
    author: "Fr. F. X. Lasance",
    classification: "Spiritualia",
    dateAdded: "2026-07-11",
  },
];

export const BOOKS_BY_SLUG = new Map(
  BOOK_CATALOG.map((book) => [book.slug, book] as const),
);
