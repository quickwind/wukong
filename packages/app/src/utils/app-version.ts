import Constants from "expo-constants";
import appPackage from "../../package.json";

function toVersionOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed;
}

export function resolveAppVersion(): string | null {
  // Irix: the app's package.json keeps x.y.z (Expo rejects a longer version), so the packaging
  // script passes the full version of the build, which is also the daemon's.
  const irixVersion = toVersionOrNull(process.env.EXPO_PUBLIC_IRIX_VERSION); // Irix
  if (irixVersion) {
    return irixVersion;
  }

  const packageVersion = toVersionOrNull(appPackage?.version);
  if (packageVersion) {
    return packageVersion;
  }

  const expoVersion = toVersionOrNull(Constants.expoConfig?.version);
  if (expoVersion) {
    return expoVersion;
  }

  const manifestVersion = toVersionOrNull(
    (Constants as unknown as { manifest?: { version?: unknown } }).manifest?.version,
  );
  if (manifestVersion) {
    return manifestVersion;
  }

  return null;
}
