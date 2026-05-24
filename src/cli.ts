#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { checkSnap, generateSnapFile } from "./idl/index";

function main(argv: readonly string[]): number {
  const [command, input, ...rest] = argv;
  if (command !== "check" && command !== "generate") {
    printUsage();
    return 1;
  }
  if (input === undefined) {
    console.error(`snapscript ${command} requires a .snap file`);
    return 1;
  }

  const options = parseOptions(rest);
  try {
    if (command === "check") {
      checkSnap(readFileSync(input, "utf8"));
      console.log(`OK ${input}`);
      return 0;
    }
    const generateOptions = {
      inputPath: input,
      write: true,
      ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
      ...(options.lockPath === undefined ? {} : { lockPath: options.lockPath }),
    } as const;
    const files = generateSnapFile(generateOptions);
    for (const file of files) {
      console.log(file.path);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseOptions(args: readonly string[]): { outDir?: string; lockPath?: string } {
  const result: { outDir?: string; lockPath?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--out") {
      if (value === undefined) throw new Error("--out requires a directory");
      result.outDir = value;
      index += 1;
      continue;
    }
    if (option === "--lock") {
      if (value === undefined) throw new Error("--lock requires a file");
      result.lockPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option "${option}"`);
  }
  return result;
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  snapscript check <schema.snap>");
  console.error("  snapscript generate <schema.snap> [--out <dir>] [--lock <file>]");
}

process.exitCode = main(process.argv.slice(2));
