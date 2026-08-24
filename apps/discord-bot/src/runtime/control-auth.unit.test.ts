import { describe, expect, it } from 'vitest'

import { classifyFilesystemControlPolicy, classifyPeerControlPrincipal } from './control.ts'

const directory = {
  uid: 0,
  gid: 987,
  mode: 0o42770,
  isDirectory: true,
  isSocket: false,
}
const socket = {
  uid: 123,
  gid: 987,
  mode: 0o140660,
  isDirectory: false,
  isSocket: true,
}

describe('control socket authorization', () => {
  it('derives a write principal from an exact root-owned environment group policy', () => {
    expect(
      classifyFilesystemControlPolicy({
        path: '/run/discord-bot/staging/control.sock',
        environment: 'staging',
        directory,
        socket,
        runtimeUid: 123,
      }),
    ).toEqual({
      id: 'unix-group:gid=987:environment=staging',
      provenance: 'filesystem-policy',
      canRead: true,
      canWrite: true,
    })
  })

  it('grants an operator peer only after its gid matches the proved filesystem policy', () => {
    const filesystemPrincipal = provedFilesystemPrincipal()
    expect(
      classifyPeerControlPrincipal({
        filesystemPrincipal,
        operatorGid: 987,
        credentials: { uid: 456, gid: 987, pid: 42 },
        runtimeUid: 123,
        environment: 'staging',
      }),
    ).toMatchObject({
      id: 'unix-peer:uid=456:gid=987:pid=42',
      provenance: 'peer-credentials',
      canRead: true,
      canWrite: true,
    })
  })

  it('denies a peer whose gid does not match the proved operator group', () => {
    const filesystemPrincipal = provedFilesystemPrincipal()
    expect(
      classifyPeerControlPrincipal({
        filesystemPrincipal,
        operatorGid: 987,
        credentials: { uid: 456, gid: 999, pid: 42 },
        runtimeUid: 123,
        environment: 'staging',
      }),
    ).toMatchObject({ canRead: false, canWrite: false })
  })

  it('allows the service uid to read but never self-authorize a write', () => {
    const filesystemPrincipal = provedFilesystemPrincipal()
    expect(
      classifyPeerControlPrincipal({
        filesystemPrincipal,
        operatorGid: 987,
        credentials: { uid: 123, gid: 987, pid: 42 },
        runtimeUid: 123,
        environment: 'staging',
      }),
    ).toMatchObject({ canRead: true, canWrite: false })
  })

  it('denies peer credentials when the filesystem policy was not verified', () => {
    expect(
      classifyPeerControlPrincipal({
        filesystemPrincipal: {
          id: 'unverified-unix-peer:environment=staging',
          provenance: 'filesystem-policy',
          canRead: false,
          canWrite: false,
        },
        operatorGid: 987,
        credentials: { uid: 456, gid: 987, pid: 42 },
        runtimeUid: 123,
        environment: 'staging',
      }),
    ).toMatchObject({ canRead: false, canWrite: false })
  })

  it.each([
    { path: '/tmp/control.sock' },
    { directory: { ...directory, uid: 123 } },
    { directory: { ...directory, mode: 0o40777 } },
    { socket: { ...socket, gid: 988 } },
    { socket: { ...socket, mode: 0o140666 } },
    { runtimeUid: 456 },
  ])('fails closed when the filesystem policy is not mechanically proven', (override) => {
    expect(
      classifyFilesystemControlPolicy({
        path: '/run/discord-bot/staging/control.sock',
        environment: 'staging',
        directory,
        socket,
        runtimeUid: 123,
        ...override,
      }),
    ).toBeUndefined()
  })
})

const provedFilesystemPrincipal = () => {
  const principal = classifyFilesystemControlPolicy({
    path: '/run/discord-bot/staging/control.sock',
    environment: 'staging',
    directory,
    socket,
    runtimeUid: 123,
  })
  if (principal === undefined) throw new Error('test filesystem policy should be valid')
  return principal
}
