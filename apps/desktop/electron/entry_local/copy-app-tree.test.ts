import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { copyAppTree } from './copy-app-tree'

test('逐层拷贝发行包目录：子目录照拷，同名文件覆盖，目标里多出的文件保留', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-app-tree-'))

  try {
    const source = path.join(root, 'app', 'assets', 'plugin')
    const destination = path.join(root, 'home', 'plugins', 'plugin')
    fs.mkdirSync(path.join(source, 'sub', 'deeper'), { recursive: true })
    fs.writeFileSync(path.join(source, 'plugin.yaml'), 'name: new\n')
    fs.writeFileSync(path.join(source, 'sub', 'deeper', 'tool.py'), 'print(2)\n')
    fs.mkdirSync(destination, { recursive: true })
    fs.writeFileSync(path.join(destination, 'plugin.yaml'), 'name: old\n')
    fs.writeFileSync(path.join(destination, 'user-note.txt'), 'kept\n')

    copyAppTree(source, destination)

    assert.equal(fs.readFileSync(path.join(destination, 'plugin.yaml'), 'utf8'), 'name: new\n')
    assert.equal(fs.readFileSync(path.join(destination, 'sub', 'deeper', 'tool.py'), 'utf8'), 'print(2)\n')
    assert.equal(fs.readFileSync(path.join(destination, 'user-note.txt'), 'utf8'), 'kept\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
