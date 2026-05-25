#!/usr/bin/env node
import { createProject } from "./project";
import { formatReport } from "snapscript-cli/project";

function main(argv: readonly string[]): number {
  const [targetDir, ...rest] = argv;
  if (targetDir === undefined || targetDir === "--help" || targetDir === "-h") {
    printUsage();
    return targetDir === undefined ? 1 : 0;
  }

  try {
    const options = parseOptions(rest);
    const report = createProject({
      cwd: process.cwd(),
      targetDir,
      ...(options.schemaPath === undefined ? {} : { schemaPath: options.schemaPath }),
    });
    console.log(formatReport(report));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseOptions(args: readonly string[]): { schemaPath?: string } {
  const result: { schemaPath?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--schema") {
      if (value === undefined) throw new Error("--schema requires a .snap file");
      result.schemaPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option "${option}"`);
  }
  return result;
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  create-snapscript <dir> [--schema <schema.snap>]");
}

process.exitCode = main(process.argv.slice(2));
