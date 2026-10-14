// Plugins written for Paseo import the SDK as `@getpaseo/plugin`. Irix's published packages
// rename that scope (the build rewrites every `@getpaseo/` in the sources), and the host only
// knows the renamed SDK, so a Paseo plugin would not build. The compiler maps the upstream name
// to this build's name, which makes Paseo's plugins work unchanged.
//
// The upstream scope is written in two pieces so the publish-time rename leaves it alone. In an
// unrenamed source tree both names are the same and nothing is mapped.

const LOCAL_SDK = "@getpaseo/plugin";
const UPSTREAM_SDK = ["@get", "paseo/plugin"].join("");

export function createSdkAlias(local: string, upstream: string) {
  const same = local === upstream;
  return {
    /** For esbuild's `alias` option. */
    alias: same ? {} : { [upstream]: local },
    /** Maps an SDK specifier as a plugin wrote it to the name this build provides. */
    toLocal(specifier: string): string {
      if (same) return specifier;
      if (specifier === upstream || specifier.startsWith(`${upstream}/`)) {
        return local + specifier.slice(upstream.length);
      }
      return specifier;
    },
  };
}

const sdkAlias = createSdkAlias(LOCAL_SDK, UPSTREAM_SDK);

export const PLUGIN_SDK_ALIAS: Record<string, string> = sdkAlias.alias;
export const toLocalSdkSpecifier = sdkAlias.toLocal;
