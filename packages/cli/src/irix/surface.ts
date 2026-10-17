// The Irix command tree: the upstream one without the commands Irix does not use. Applied at the
// end of createCli so upstream's registration code stays as it is.

import type { Command } from "commander";

const UNUSED_COMMANDS = ["clone", "onboard", "pair", "hub", "speech"];

function removeCommand(parent: Command, name: string): void {
  const commands = parent.commands as Command[];
  const index = commands.findIndex((command) => command.name() === name);
  if (index >= 0) {
    commands.splice(index, 1);
  }
}

export function applyIrixSurface(program: Command): Command {
  program
    .name("irix")
    .description("Irix CLI - control your AI coding agents from the command line");
  for (const name of UNUSED_COMMANDS) {
    removeCommand(program, name);
  }
  const daemon = program.commands.find((command) => command.name() === "daemon");
  if (daemon) {
    removeCommand(daemon, "pair");
  }
  return program;
}
