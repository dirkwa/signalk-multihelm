import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  COURSE_PATH,
  MasterCourse,
  courseSetting,
  onTheWay,
  writeCourse,
  type CourseSetting
} from '../src/course-from-master.js'
import { MasterControlAccess } from '../src/master-control.js'
import { OwnServerAccess } from '../src/own-access.js'
import { MultihelmStore } from '../src/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multihelm-course-'))

const NONE = {
  activeRoute: null,
  nextPoint: null,
  previousPoint: null,
  arrivalCircle: 0,
  targetArrivalTime: null
}

interface Server {
  url: string
  course: Record<string, unknown>
  writes: string[]
  /** Answered with this status once, then as usual. */
  failNext: { request: string; status: number } | null
  accessRequests: number
  close: () => void
}

/** A Course API that keeps its course in memory, as the server's does for these calls. */
async function courseServer(): Promise<Server> {
  const server: Server = {
    url: '',
    course: { ...NONE },
    writes: [],
    failNext: null,
    accessRequests: 0,
    close: () => undefined
  }
  const app = express()
  app.use(express.json())
  app.post('/signalk/v1/access/requests', (_req, res) => {
    server.accessRequests++
    res.sendStatus(404)
  })
  app.use(COURSE_PATH, (req, res, next) => {
    const fail = server.failNext
    if (fail && fail.request === `${req.method} ${req.path}`) {
      server.failNext = null
      res.sendStatus(fail.status)
      return
    }
    next()
  })
  app.get(COURSE_PATH, (_req, res) => {
    res.json(server.course)
  })
  app.use(COURSE_PATH, (req, res) => {
    server.writes.push(`${req.method} ${req.path}`)
    const body = (req.body ?? {}) as Record<string, unknown>
    const circle = typeof body.arrivalCircle === 'number' ? body.arrivalCircle : undefined
    const course = server.course
    if (req.method === 'DELETE') {
      server.course = { ...NONE, arrivalCircle: course.arrivalCircle }
    } else if (req.path === '/activeRoute') {
      server.course = {
        ...course,
        activeRoute: { href: body.href, pointIndex: body.pointIndex, reverse: !!body.reverse },
        nextPoint: { type: 'RoutePoint', position: { latitude: 1, longitude: 2 } },
        arrivalCircle: circle ?? course.arrivalCircle
      }
    } else if (req.path === '/destination') {
      server.course = {
        ...course,
        activeRoute: null,
        nextPoint:
          typeof body.href === 'string'
            ? { href: body.href, type: 'Waypoint', position: { latitude: 3, longitude: 4 } }
            : { type: 'Location', position: body.position },
        arrivalCircle: circle ?? course.arrivalCircle
      }
    } else {
      const field = req.path.slice(1)
      server.course = { ...course, [field]: body.value }
    }
    res.json({ state: 'COMPLETED', statusCode: 200 })
  })
  const http_ = http.createServer(app)
  await new Promise<void>((resolve) => http_.listen(0, '127.0.0.1', resolve))
  const { port } = http_.address() as AddressInfo
  server.url = `http://127.0.0.1:${String(port)}`
  server.close = () => {
    http_.close()
  }
  return server
}

const ROUTE = { href: '/resources/routes/home', pointIndex: 0, reverse: false }

describe('the course in a Course API answer', () => {
  it('is the route, or the destination when no route is active', () => {
    expect(
      courseSetting({
        ...NONE,
        activeRoute: { ...ROUTE, name: 'Home', pointTotal: 4 },
        nextPoint: { position: { latitude: 1, longitude: 2 } },
        arrivalCircle: 50
      })
    ).toEqual({ route: ROUTE, point: null, arrivalCircle: 50, targetArrivalTime: null })
    expect(
      courseSetting({ ...NONE, nextPoint: { href: '/resources/waypoints/a', position: {} } })
    ).toEqual({
      route: null,
      point: { href: '/resources/waypoints/a' },
      arrivalCircle: 0,
      targetArrivalTime: null
    })
    expect(courseSetting('nothing')).toBeNull()
  })
})

describe('a course on the way from one setting to another', () => {
  it('has each part as in one of them', () => {
    const from: CourseSetting = {
      route: null,
      point: null,
      arrivalCircle: 0,
      targetArrivalTime: null
    }
    const to: CourseSetting = { ...from, route: ROUTE, targetArrivalTime: '2026-11-17T08:00:00Z' }
    expect(onTheWay({ ...from, route: ROUTE }, from, to)).toBe(true)
    expect(onTheWay({ ...from, route: ROUTE, arrivalCircle: 99 }, from, to)).toBe(false)
  })
})

describe('writing a course', () => {
  it('sets its arrival time again after clearing, which clears it', async () => {
    const calls: string[] = []
    const from: CourseSetting = {
      route: null,
      point: { href: '/resources/waypoints/a' },
      arrivalCircle: 0,
      targetArrivalTime: '2026-11-17T08:00:00Z'
    }
    await writeCourse(
      (method, p) => {
        calls.push(`${method} ${p}`)
        return Promise.resolve(null)
      },
      from,
      { ...from, point: null }
    )
    expect(calls).toEqual(['DELETE ', 'PUT /targetArrivalTime'])
  })
})

describe('the course on a server that is not the master', () => {
  let master: Server
  let here: Server
  let isMaster = false

  beforeAll(async () => {
    master = await courseServer()
    here = await courseServer()
  })

  afterAll(() => {
    master.close()
    here.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    master.course = { ...NONE }
    here.course = { ...NONE }
    master.writes = []
    here.writes = []
    master.failNext = null
    here.failNext = null
    here.accessRequests = 0
    isMaster = false
  })

  function make(name: string): MasterCourse {
    const store = new MultihelmStore(path.join(root, name))
    return new MasterCourse({
      master: () =>
        isMaster ? null : { id: 'salon', access: { url: master.url, token: 'pairing-token' } },
      control: new MasterControlAccess({
        store,
        serverId: 'port',
        currentMaster: () => (isMaster ? null : 'salon'),
        debug: () => undefined
      }),
      own: new OwnServerAccess({
        store,
        serverId: 'port',
        ownUrl: () => here.url,
        debug: () => undefined
      }),
      ownUrl: () => here.url,
      debug: () => undefined
    })
  }

  it("takes the master's course over", async () => {
    master.course = { ...NONE, activeRoute: ROUTE, arrivalCircle: 50 }
    await make('take').sync()
    expect(courseSetting(here.course)).toEqual(courseSetting(master.course))
    expect(master.writes).toEqual([])
  })

  it('sends a course set here to the master, as the point it is on', async () => {
    const course = make('send')
    master.course = { ...NONE, activeRoute: ROUTE }
    await course.sync()
    here.course = { ...here.course, activeRoute: { ...ROUTE, pointIndex: 2 } }
    await course.sync()
    expect(master.writes).toEqual(['PUT /activeRoute'])
    expect(courseSetting(master.course)?.route?.pointIndex).toBe(2)

    here.course = { ...NONE }
    await course.sync()
    expect(courseSetting(master.course)).toEqual(courseSetting(NONE))
  })

  it("keeps the master's course when both changed", async () => {
    const course = make('both')
    await course.sync()
    master.course = { ...NONE, activeRoute: ROUTE }
    here.course = { ...NONE, nextPoint: { position: { latitude: 5, longitude: 6 } } }
    await course.sync()
    expect(master.writes).toEqual([])
    expect(courseSetting(here.course)).toEqual(courseSetting(master.course))
  })

  it('does nothing on the master', async () => {
    isMaster = true
    master.course = { ...NONE, activeRoute: ROUTE }
    here.course = { ...NONE, nextPoint: { position: { latitude: 5, longitude: 6 } } }
    await make('master').sync()
    expect([...master.writes, ...here.writes]).toEqual([])
  })
  it('sends a change again that reached the master only in part', async () => {
    const course = make('partial')
    await course.sync()
    here.course = { ...NONE, activeRoute: ROUTE, targetArrivalTime: '2026-11-17T08:00:00Z' }
    master.failNext = { request: 'PUT /targetArrivalTime', status: 500 }
    await course.sync()
    expect(courseSetting(master.course)?.route).toEqual(ROUTE)
    await course.sync()
    expect(courseSetting(master.course)).toEqual(courseSetting(here.course))
    expect(courseSetting(here.course)?.targetArrivalTime).toBe('2026-11-17T08:00:00Z')
  })

  it('asks for its own access again when this server refuses it', async () => {
    const course = make('refused')
    await course.sync()
    expect(here.accessRequests).toBe(1)
    here.failNext = { request: 'GET /', status: 401 }
    await course.sync()
    await course.sync()
    expect(here.accessRequests).toBe(2)
  })

  it('keeps a change made on the master while a partial change from here waits', async () => {
    const course = make('partial-then-master')
    await course.sync()
    here.course = { ...NONE, activeRoute: ROUTE, targetArrivalTime: '2026-11-17T08:00:00Z' }
    master.failNext = { request: 'PUT /targetArrivalTime', status: 500 }
    await course.sync()
    master.course = { ...master.course, arrivalCircle: 99 }
    const sent = master.writes.length
    await course.sync()
    expect(master.writes).toHaveLength(sent)
    expect(courseSetting(here.course)).toEqual(courseSetting(master.course))
  })

  it('writes nothing once stopped', async () => {
    const course = make('stopped')
    master.course = { ...NONE, activeRoute: ROUTE }
    course.stop()
    await course.sync()
    expect(here.writes).toEqual([])
  })
})
