/* Screener: client-side filtering of the server-rendered membership table. */
"use strict";

(function () {
  if (!document.getElementById("screener-table")) return;
  qe.tableFilter("screener-table", {
    search: "screener-q",
    count: "screener-count",
    facets: [
      { id: "screener-sector", attr: "sector" },
      { id: "screener-book", test: (row) => {
          const r = parseFloat(row.dataset.modelRank);
          return !isNaN(r) && r <= 50;
        } },
    ],
  });
})();
