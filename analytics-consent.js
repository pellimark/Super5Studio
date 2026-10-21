(() => {
  const measurementId = "G-7H021NMKHF";
  const preferenceKey = "super5-analytics-consent";
  const banner = document.querySelector("[data-analytics-consent]");

  if (!banner) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() {
    window.dataLayer.push(arguments);
  };

  window.gtag("consent", "default", { analytics_storage: "denied" });
  window.gtag("js", new Date());

  let analyticsLoaded = false;

  function showPreferences() {
    banner.hidden = false;
    banner.querySelector("[data-analytics-consent-choice='granted']")?.focus();
  }

  function clearAnalyticsCookies() {
    document.cookie.split(";").forEach((cookie) => {
      const name = cookie.split("=")[0].trim();
      if (!name.startsWith("_ga")) return;
      document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
    });
  }

  function enableAnalytics() {
    window[`ga-disable-${measurementId}`] = false;
    window.gtag("consent", "update", { analytics_storage: "granted" });

    if (analyticsLoaded) return;
    analyticsLoaded = true;

    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
    script.onload = () => window.gtag("config", measurementId);
    document.head.appendChild(script);
  }

  function saveChoice(choice) {
    try {
      window.localStorage.setItem(preferenceKey, choice);
    } catch {
      // Keep the current visit's choice even when browser storage is unavailable.
    }

    banner.hidden = true;

    if (choice === "granted") {
      enableAnalytics();
    } else {
      window[`ga-disable-${measurementId}`] = true;
      window.gtag("consent", "update", { analytics_storage: "denied" });
      clearAnalyticsCookies();
    }
  }

  let savedChoice = null;
  try {
    savedChoice = window.localStorage.getItem(preferenceKey);
  } catch {
    // Ask again on the next page visit when browser storage is unavailable.
  }

  if (savedChoice === "granted") {
    enableAnalytics();
  } else if (savedChoice !== "denied") {
    showPreferences();
  }

  banner.querySelectorAll("[data-analytics-consent-choice]").forEach((button) => {
    button.addEventListener("click", () => saveChoice(button.dataset.analyticsConsentChoice));
  });

  document.querySelectorAll("[data-open-analytics-preferences]").forEach((button) => {
    button.addEventListener("click", showPreferences);
  });
})();
