/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Command, CommandParams, CommandResult, BooleanParameter, StringsParameter } from "./base"
import yaml, { safeDump } from "js-yaml"
import { dedent } from "../util/string"
import { readFile, writeFile } from "fs-extra"
import { cloneDeep, isEqual } from "lodash"
import { ConfigurationError, RuntimeError } from "../exceptions"
import { basename, resolve, parse } from "path"
import { findConfigPathsInPath, getConfigFilePath } from "../util/fs"
import { GitHandler } from "../vcs/git"
import { DEFAULT_GARDEN_DIR_NAME } from "../constants"
import { exec } from "../util/util"
import { LoggerType } from "../logger/logger"
import Bluebird from "bluebird"

const migrateOptions = {
  write: new BooleanParameter({ help: "Update the `garden.yml` in place." }),
}

const migrateArguments = {
  configPaths: new StringsParameter({
    help: "Specify the path to a `garden.yml` file to convert. Use comma as a separator to specify multiple files.",
  }),
}

type Args = typeof migrateArguments
type Opts = typeof migrateOptions

interface UpdatedConfig {
  path: string
  specs: any[]
}

export interface MigrateCommandResult {
  updatedConfigs: UpdatedConfig[]
}

export class MigrateCommand extends Command<Args, Opts> {
  name = "migrate"
  noProject = true
  loggerType: LoggerType = "basic"
  arguments = migrateArguments
  options = migrateOptions
  help = "Migrate `garden.yml` configuration files to version v0.11.x"

  description = dedent`
    Scans the project for \`garden.yml\` configuration files and updates those that are not compatible with version v0.11 or greater.
    By default the command prints the updated version to the terminal. You can optionally update the files in place with the \`write\` flag.

    Note: This command does not validate the configs per se. It will simply try to convert a give configuration file so that
    it is compatible with version v0.11 or greater, regardless of whether that file was ever valid Garden config. It is therefore
    recommended that this is used on existing \`garden.yml\` files that were valid in version v0.10.x.

    Examples:

        garden migrate              # scans all garden.yml files and prints the updated version along with the path to it.
        garden migrate --write      # scans all garden.yml files writes the updated version to the file system.
        garden migrate ./garden.yml # scans the provided garden.yml file and prints the updated version. Useful for piping the output to the file.

  `

  async action({ log, args, opts }: CommandParams<Args, Opts>): Promise<CommandResult<MigrateCommandResult>> {
    // opts.root defaults to current directory
    const root = await findRoot(opts.root)
    if (!root) {
      throw new ConfigurationError(`Not a project directory (or any of the parent directories): ${opts.root}`, {
        root: opts.root,
      })
    }

    const updatedConfigs: { path: string; specs: any[] }[] = []

    let configPaths: string[] = []
    if (args.configPaths && args.configPaths.length > 0) {
      configPaths = args.configPaths.map((path) => resolve(root, path))
    } else {
      const vcs = new GitHandler(resolve(root, DEFAULT_GARDEN_DIR_NAME), [])
      configPaths = await findConfigPathsInPath({
        dir: root,
        vcs,
        log,
      })
    }

    // Iterate over configs and update specs if needed
    for (const configPath of configPaths) {
      const updatedSpecs: any[] = []

      const rawSpecs = await readYaml(configPath)
      const original = cloneDeep(rawSpecs)

      for (let spec of rawSpecs) {
        spec = applyFlatStyle(spec)

        removeLocalOpenFaas(spec)
        removeEnvironmentDefaults(spec, configPath)

        updatedSpecs.push(spec)
      }

      // Nothing to do
      if (isEqual(rawSpecs, original)) {
        continue
      }

      updatedConfigs.push({
        path: configPath,
        specs: updatedSpecs,
      })
    }

    // Throw if any config files have been modified so that user changes don't get overwritten
    if (opts.write) {
      const dirtyConfigs = await Bluebird.map(updatedConfigs, async ({ path }) => {
        const modified = !!(
          await exec("git", ["ls-files", "-m", "--others", "--exclude-standard", path], { cwd: root })
        ).stdout
        if (modified) {
          return path
        }
        return null
      }).filter(Boolean)
      if (dirtyConfigs.length > 0) {
        const msg = dedent`
        Config files at paths ${dirtyConfigs.join(", ")} are dirty.
        Please commit all changes before applying this command with the --write flag
        `
        throw new RuntimeError(msg, { dirtyConfigs })
      }
    }

    // Iterate over updated configs and print or write
    for (const { path, specs } of updatedConfigs) {
      const out = dumpSpec(specs)

      if (opts.write) {
        log.info(`Updating file at path ${path}`)
        await writeFile(path, out)
      } else {
        if (configPaths.length > 0) {
          log.info(`# Updated config at path ${path}`)
        }
        log.info(out)
      }
    }

    return { result: { updatedConfigs } }
  }
}

/**
 * Dump JSON specs to YAML. Join specs by `---`.
 */
export function dumpSpec(specs: any[]) {
  return specs.map((spec) => safeDump(spec)).join("\n---\n\n")
}

/**
 * Recursively search for the project root by checking if the path has a project level `garden.yml` file
 */
async function findRoot(path: string): Promise<string | null> {
  const configFilePath = await getConfigFilePath(path)
  let isProjectRoot = false
  try {
    const rawSpecs = await readYaml(configFilePath)
    isProjectRoot = rawSpecs.find((spec) => !!spec.project || spec.kind === "Project")
  } catch (err) {
    // no op
  }
  if (isProjectRoot) {
    return path
  }

  // We're at the file system root and no project file was found
  if (parse(path).root) {
    return null
  }
  return findRoot(resolve(path, ".."))
}

/**
 * Read the contents of a YAML file and dump to JSON
 */
async function readYaml(path: string) {
  let rawSpecs: any[]
  const fileData = await readFile(path)

  try {
    rawSpecs = yaml.safeLoadAll(fileData.toString()) || []
  } catch (err) {
    throw new ConfigurationError(`Could not parse ${basename(path)} in directory ${path} as valid YAML`, err)
  }

  // Ignore empty resources
  return rawSpecs.filter(Boolean)
}

/**
 * Convert to flat config style.
 *
 * That is, this:
 * ```yaml
 * project:
 *   providers:
 *    ...
 * ```
 * becomes:
 * ```yaml
 * kind: Project:
 * providers:
 * ...
 * ```
 */
function applyFlatStyle(spec: any) {
  if (spec.project) {
    spec = {
      kind: "Project",
      ...spec.project,
    }
  } else if (spec.module) {
    spec = {
      kind: "Module",
      ...spec.module,
    }
  }
  return spec
}

/**
 * Change `local-openfaas` provider and module types to `openfaas`. Mutates spec.
 */
function removeLocalOpenFaas(spec: any) {
  const isProject = spec.kind === "Project"

  // Remove local-openfaas from modules
  if (spec.type === "local-openfaas") {
    spec.type = "openfaas"
  }

  // Remove local-openfaas from projects
  if (isProject) {
    // Provider nested under environment
    for (const [envIdx, env] of spec.environments.entries()) {
      if (!env.providers) {
        continue
      }
      for (const [providerIdx, provider] of env.providers.entries()) {
        if (provider.name === "local-openfaas") {
          spec.environments[envIdx].providers[providerIdx].name = "openfaas"
        }
      }
    }

    // Provider nested under environment
    if (spec.providers) {
      for (const [providerIdx, provider] of spec.providers.entries()) {
        if (provider.name === "local-openfaas") {
          spec.providers[providerIdx].name = "openfaas"
        }
      }
    }
  }
}

/**
 * Remove `environmentDefaults` field and map its contents to their respective top-level keys
 */
function removeEnvironmentDefaults(spec: any, path: string) {
  if (spec.environmentDefaults) {
    if (spec.environmentDefaults.varfile) {
      if (spec.varfile) {
        const msg = dedent`
          Detected a project level \`varfile\` field with value ${spec.varfile} in config at path ${path}
          when attempting to re-assign the \`varfile\` field under the
          \`environmentDefaults\` directive (with value ${spec.environmentDefaults.varfile}).
          Please resolve manually and then run this command again.
        `
        throw new ConfigurationError(msg, { path })
      } else {
        spec.varfile = spec.environmentDefaults.varfile
      }
    }
    if (spec.environmentDefaults.variables) {
      // Merge variables
      spec.variables = {
        ...(spec.variables || {}),
        ...spec.environmentDefaults.variables,
      }
    }

    if (spec.environmentDefaults.providers) {
      spec.providers = [...(spec.providers || []), ...spec.environmentDefaults.providers]
    }
    delete spec.environmentDefaults
  }
}
