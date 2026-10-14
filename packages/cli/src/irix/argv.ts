// Run from bin/wukong before the CLI starts.
//
// On Windows a message such as `wukong send <id> "What are you doing?"` can reach the CLI cut at the
// spaces with the quotes still on: `"What`, `are`, `you`, `doing?"`. This happened with commands
// run by Devin; the CLI then took the first piece as the whole message. A correctly parsed argument
// never starts with a quote mark that closes only in a later argument, so that shape is put back
// together here: the pieces are joined with a space and the outer quotes removed.

const QUOTES = new Set(['"', "'"]);

/** The arguments, with a quoted message that arrived in pieces joined back into one. */
export function mendSplitQuotedArgs(args: readonly string[]): string[] {
  const mended: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const quote = arg.charAt(0);
    if (!QUOTES.has(quote) || (arg.length > 1 && arg.endsWith(quote))) {
      mended.push(arg);
      continue;
    }
    const closing = args.findIndex((later, at) => at > index && later.endsWith(quote));
    if (closing === -1) {
      mended.push(arg);
      continue;
    }
    mended.push(
      args
        .slice(index, closing + 1)
        .join(" ")
        .slice(1, -1),
    );
    index = closing;
  }
  return mended;
}
