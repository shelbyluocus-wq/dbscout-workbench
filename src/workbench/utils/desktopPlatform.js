export function detectDesktopPlatform(navigatorLike = globalThis.navigator) {
  const platformSignals = [
    navigatorLike?.userAgentData?.platform,
    navigatorLike?.platform,
    navigatorLike?.userAgent,
  ]
    .filter(Boolean)
    .join(" ");

  if (/(?:Macintosh|MacIntel|MacPPC|Mac68K|\bmacOS\b)/i.test(platformSignals)) {
    return "macos";
  }
  if (/(?:Windows|Win32|Win64)/i.test(platformSignals)) {
    return "windows";
  }
  if (/(?:Linux|X11)/i.test(platformSignals)) {
    return "linux";
  }
  return "unknown";
}

export function isMacOSPlatform(navigatorLike = globalThis.navigator) {
  return detectDesktopPlatform(navigatorLike) === "macos";
}
