/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import uuidv4 from "uuid/v4"
import segmentClient = require("analytics-node")
import { platform, release } from "os"
import ci = require("ci-info")

import { globalConfigKeys, AnalyticsGlobalConfig, GlobalConfigStore } from "../config-store"
import { getPackageVersion } from "../util/util"
import { SEGMENT_PROD_API_KEY, SEGMENT_DEV_API_KEY } from "../constants"
import { LogEntry } from "../logger/log-entry"
import { printWarningMessage } from "../logger/util"
import { GitHandler } from "../vcs/git"
import hasha = require("hasha")
import uuid from "uuid"
import { Garden } from "../garden"
import { Events, EventName } from "../events"
import { AnalyticsType } from "./analytics-types"
import { TestConfig } from "../config/test"
import dedent from "dedent"

const API_KEY = process.env.ANALYTICS_DEV ? SEGMENT_DEV_API_KEY : SEGMENT_PROD_API_KEY

export interface SystemInfo {
  gardenVersion: string
  platform: string
  platformVersion: string
}

export interface AnalyticsEventProperties {
  projectId: string
  system: SystemInfo
  isCI: boolean
  sessionId: string
  projectMetadata: any
}

export interface AnalyticsCommandEventProperties extends AnalyticsEventProperties {
  name: string
}

export interface AnalyticsTaskEventProperties extends AnalyticsEventProperties {
  batchId: string
  taskType: string
  taskName: string
  taskStatus: string
}
export interface AnalyticsApiEventProperties extends AnalyticsEventProperties {
  path: string
  command: string
  name: string
}

export interface AnalyticsConfigErrorProperties extends AnalyticsEventProperties {
  moduleType: string
}

export interface AnalyticsProjectErrorProperties extends AnalyticsEventProperties {
  fields: Array<string>
}

export interface AnalyticsValidationErrorProperties extends AnalyticsEventProperties {
  fields: Array<string>
}

export interface ApiRequestBody {
  command: string
}

export interface AnalyticsEvent {
  type: AnalyticsType
  properties: AnalyticsEventProperties
}

export interface SegmentEvent {
  userId: string
  event: AnalyticsType
  properties: AnalyticsEventProperties
}

type SupportedEvents = Events["taskPending"] | Events["taskProcessing"] | Events["taskComplete"] | Events["taskError"]

/**
 * A Segment client wrapper with utility functionalities like local and global config and info,
 * prompt for opt-in/opt-out and wrappers for single events.
 *
 * Usage:
 *
 * const analyticsClient = await new Analytics(garden: Garden).init()
 * analyticsClient.trackCommand(commandName)
 *
 * @export
 * @class Analytics
 */
export class AnalyticsHandler {
  private static instance: AnalyticsHandler
  private segment: any
  private log: LogEntry
  private globalConfig: AnalyticsGlobalConfig
  private globalConfigStore: GlobalConfigStore
  private projectId = ""
  private systemConfig: SystemInfo
  private isCI = ci.isCI
  private sessionId = uuid.v4()
  private garden: Garden
  private projectMetadata

  private constructor(garden: Garden, log: LogEntry) {
    this.segment = new segmentClient(API_KEY, { flushAt: 10, flushInterval: 300 })
    this.log = log
    this.garden = garden
    this.globalConfigStore = new GlobalConfigStore()
    this.globalConfig = {
      userId: "",
      firstRun: true,
      optedIn: false,
      showOptInMessage: true,
    }

    this.systemConfig = {
      platform: platform(),
      platformVersion: release(),
      gardenVersion: getPackageVersion().toString(),
    }
  }

  static async init(garden: Garden, log: LogEntry) {
    if (!AnalyticsHandler.instance) {
      AnalyticsHandler.instance = await new AnalyticsHandler(garden, log).initialize()
    }
    return AnalyticsHandler.instance
  }

  static getInstance(): AnalyticsHandler {
    if (!AnalyticsHandler.instance) {
      throw Error("Analytics not initialized. Init first")
    }
    return AnalyticsHandler.instance
  }

  /**
   * A factory function which returns an initialized Analytics object, ready to be used.
   * This function will load global and local config stores and update them if needed.
   * The globalConfigStore contains info about optIn, first run, machine info, etc., while
   * the localStore contains info about the project.
   * If the Analytics has never been initalized, this function will prompt the user to ask
   * permission for the collection of the data. This method always needs to be called after
   * instantiation.
   *
   * @returns
   * @memberof Analytics
   */
  async initialize() {
    debugger
    const globalConf = await this.globalConfigStore.get()
    this.globalConfig = {
      ...this.globalConfig,
      ...globalConf.analytics,
    }

    const vcs = new GitHandler(process.cwd(), [])
    const originName = await vcs.getOriginName()
    this.projectId = originName ? hasha(await vcs.getOriginName(), { algorithm: "sha256" }) : "unset"

    if (this.globalConfig.firstRun || this.globalConfig.showOptInMessage) {
      if (!this.isCI) {
        printWarningMessage(
          this.log,
          dedent`
          Thanks for installing Garden! We work hard to provide you with the best experience we can.
          We collect some anonymized usage data while you use Garden. If you'd like to know more about what we collect
          or you'd like to to opt-out, please read more at https://github.com/garden-io/garden/blob/master/README.md#Analytics`
        )
      }

      this.globalConfig = {
        firstRun: false,
        userId: this.globalConfig.userId || uuidv4(),
        optedIn: true,
        showOptInMessage: false,
      }

      await this.globalConfigStore.set([globalConfigKeys.analytics], this.globalConfig)

      if (this.segment && this.globalConfig.optedIn) {
        this.segment.identify({
          userId: this.globalConfig.userId,
          traits: {
            platform: platform(),
            platformVersion: release(),
            gardenVersion: getPackageVersion(),
          },
        })
      }
    }
    // Subscribe to the TaskGraph events
    this.garden.events.onAny((name, payload) => this.processEvent(name, payload))

    // Generate the project metadata
    const configGraph = await this.garden.getConfigGraph(this.log)
    const modules = await configGraph.getModules()
    const modulesTypes = [...new Set(modules.map((m) => m.type))]

    const tasks = await configGraph.getTasks()
    const services = await configGraph.getServices()
    const tests = modules.map((m) => m.testConfigs)
    const numberOfTests = ([] as TestConfig[]).concat(...tests).length

    this.projectMetadata = {
      numberOfModules: modules.length,
      modulesTypes,
      numberOfTasks: tasks.length,
      numberOfServices: services.length,
      numberOfTests,
    }

    return this
  }

  hasOptedIn(): boolean {
    return this.globalConfig.optedIn || false
  }

  private getBasicAnalyticsProperties(): AnalyticsEventProperties {
    return {
      projectId: this.projectId,
      system: this.systemConfig,
      isCI: this.isCI,
      sessionId: this.sessionId,
      projectMetadata: this.projectMetadata,
    }
  }

  /**
   * It sets the optedIn property in the globalConfigStore.
   * This is the property checked to decide if an event should be tracked or not.
   *
   * @param {boolean} isOptedIn
   * @memberof Analytics
   */
  async setAnalyticsOptIn(isOptedIn: boolean) {
    this.globalConfig.optedIn = isOptedIn
    await this.globalConfigStore.set([globalConfigKeys.analytics, "optedIn"], isOptedIn)
  }

  /**
   * The actual segment track method.
   *
   * @private
   * @param {AnalyticsEvent} event The event to track
   * @returns
   * @memberof Analytics
   */
  private track(event: AnalyticsEvent) {
    if (this.segment && this.hasOptedIn()) {
      const segmentEvent: SegmentEvent = {
        userId: this.globalConfig.userId,
        event: event.type,
        properties: {
          ...this.getBasicAnalyticsProperties(),
          ...event.properties,
        },
      }

      const trackToRemote = (eventToTrack: SegmentEvent) => {
        this.segment.track(eventToTrack, (err) => {
          if (err && this.log) {
            this.log.debug(`Error sending tracking event: ${err}`)
          }
        })
      }

      return trackToRemote(segmentEvent)
    }
    return false
  }

  /**
   * Tracks a Command.
   *
   * @param {string} commandName The name of the command
   * @returns
   * @memberof Analytics
   */
  trackCommand(commandName: string) {
    return this.track({
      type: AnalyticsType.COMMAND,
      properties: <AnalyticsCommandEventProperties>{
        name: commandName,
        ...this.getBasicAnalyticsProperties(),
      },
    })
  }

  /**
   * Tracks a Garden Task. The taskName is hashed since it could contain sensitive information
   *
   * @param {string} taskName The name of the Task. Usually in the format '<taskType>.<moduleName>'
   * @param {string} taskType The type of the Task
   * @returns
   * @memberof Analytics
   */
  trackTask(batchId: string, taskName: string, taskType: string, taskStatus: string) {
    const hashedTaskName = hasha(taskName, { algorithm: "sha256" })
    const properties: AnalyticsTaskEventProperties = {
      batchId,
      taskName: hashedTaskName,
      taskType,
      ...this.getBasicAnalyticsProperties(),
      taskStatus,
    }

    return this.track({
      type: AnalyticsType.TASK,
      properties,
    })
  }

  /**
   *  Tracks an Api call generated from within the Dashboard.
   *
   * @param {string} method The HTTP method of the request
   * @param {string} path The path of the request
   * @param {ApiRequestBody} body The body of the request.
   * NOTE: for privacy issues we only collect the 'command' from the body
   * @returns
   * @memberof Analytics
   */
  trackApi(method: string, path: string, body: ApiRequestBody) {
    const properties: AnalyticsApiEventProperties = {
      name: `${method} request`,
      path,
      command: body.command,
      ...this.getBasicAnalyticsProperties(),
    }

    return this.track({
      type: AnalyticsType.CALL_API,
      properties,
    })
  }

  trackModuleConfigError(moduleType: string) {
    return this.track(<AnalyticsEvent>{
      type: AnalyticsType.MODULE_CONFIG_ERROR,
      properties: <AnalyticsConfigErrorProperties>{
        ...this.getBasicAnalyticsProperties(),
        moduleType,
      },
    })
  }

  trackProjectConfigError(fields: Array<string>) {
    return this.track({
      type: AnalyticsType.PROJECT_CONFIG_ERROR,
      properties: <AnalyticsProjectErrorProperties>{
        ...this.getBasicAnalyticsProperties(),
        fields,
      },
    })
  }

  trackConfigValidationError(fields: Array<string>) {
    return this.track({
      type: AnalyticsType.VALIDATION_ERROR,
      properties: <AnalyticsValidationErrorProperties>{
        ...this.getBasicAnalyticsProperties(),
        fields,
      },
    })
  }

  flush() {
    return new Promise((resolve) =>
      this.segment.flush((err, _data) => {
        if (err && this.log) {
          this.log.debug(`Error flushing analytics: ${err}`)
        }
        resolve()
      })
    )
  }

  private processEvent<T extends EventName>(name: T, payload: Events[T]) {
    if (AnalyticsHandler.isSupportedEvent(name, payload)) {
      this.trackTask(payload.batchId, payload.name, payload.type, name)
    }
  }

  static isSupportedEvent(name: EventName, _event: Events[EventName]): _event is SupportedEvents {
    const supportedEventsKeys = ["taskPending", "taskProcessing", "taskComplete", "taskError"]
    return supportedEventsKeys.includes(name)
  }
}
