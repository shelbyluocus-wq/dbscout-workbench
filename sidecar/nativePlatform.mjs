function isMuslRuntime() {
  try {
    const report =
      typeof process.report?.getReport === "function"
        ? process.report.getReport()
        : null;
    const libc = report?.header?.libc;
    return libc ? String(libc).toLowerCase().includes("musl") : false;
  } catch {
    return false;
  }
}

export function nativeSdkPackageName({
  platform = process.platform,
  arch = process.arch,
  musl,
} = {}) {
  if (platform === "win32") {
    return arch === "arm64"
      ? "claude-agent-sdk-win32-arm64"
      : "claude-agent-sdk-win32-x64";
  }

  if (platform === "darwin") {
    return arch === "arm64"
      ? "claude-agent-sdk-darwin-arm64"
      : "claude-agent-sdk-darwin-x64";
  }

  if (platform === "linux") {
    const usesMusl = musl ?? isMuslRuntime();
    const architecture = arch === "arm64" ? "arm64" : "x64";
    return `claude-agent-sdk-linux-${architecture}${usesMusl ? "-musl" : ""}`;
  }

  return null;
}

export function nativeCliBinaryName(platform = process.platform) {
  return platform === "win32" ? "claude.exe" : "claude";
}
