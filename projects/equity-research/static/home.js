/* Home page: the aggregate rank-profile chart for the first active model. */
"use strict";

(function () {
  const panel = document.getElementById("s-rank");
  if (!panel) return;
  const mid = panel.dataset.modelId;

  qe.fetch("/api/model/" + mid + "/rank_profile").then((rep) => {
    const meta = document.getElementById("rank-profile-meta");
    if (!rep.available) {
      meta.textContent = rep.reason;
      return;
    }
    meta.textContent = qe.rankProfileMeta(rep);
    qe.renderRankProfile("chart-rank-profile", rep);
  }).catch((e) => console.error(e));
})();
