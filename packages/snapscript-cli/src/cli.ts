#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { checkSnap, generateSnapFile } from "./idl/index";
import { formatReport, generateProject } from "./project";

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

  try {
    if (command === "check") {
      checkSnap(readFileSync(input, "utf8"));
      console.log(`OK ${input}`);
      return 0;
    }
    const options = parseGenerateOptions(rest);
    const generateOptions = {
      inputPath: input,
      write: true,
      ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
    } as const;
    if (options.project === true) {
      const report = generateProject({
        cwd: process.cwd(),
        schemaPath: input,
        ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
      });
      console.log(formatReport(report));
      return 0;
    }
    const files = generateSnapFile(generateOptions);
    for (const file of files) console.log(file.path);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseGenerateOptions(args: readonly string[]): { outDir?: string; project?: true } {
  const result: { outDir?: string; project?: true } = { project: true };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--out") {
      if (value === undefined) throw new Error("--out requires a directory");
      result.outDir = value;
      index += 1;
      continue;
    }
    if (option === "--protocol-only") {
      delete result.project;
      continue;
    }
    throw new Error(`Unknown option "${option}"`);
  }
  return result;
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  snapscript check <schema.snap>");
  console.error("  snapscript generate <schema.snap> [--out <dir>]");
}

process.exitCode = main(process.argv.slice(2));
