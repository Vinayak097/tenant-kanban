import { useEffect, useState, type FormEvent, type DragEvent } from 'react'
import { io, type Socket } from 'socket.io-client'
import './App.css'

type Role = 'ORG_ADMIN' | 'TENANT_ADMIN' | 'MEMBER'
type AuthUser = { id: string; username: string; email: string; role: Role; organizationId: string; tenantId: string | null }
type Organization = { id: string; name: string }
type Tenant = { id: string; name: string; organizationId: string }
type Board = { id: string; name: string; tenantId: string }
type Task = { id: string; title: string; description: string | null; tenantId: string; columnId: string; position: number; version: number }
type Column = { id: string; name: string; tenantId: string; boardId: string; position: number; tasks: Task[] }
type BoardDetail = Board & { columns: Column[] }
type Activity = { id: string; entityType: string; action: string; oldValues: unknown; newValues: unknown; createdAt: string }

const roleLabels: Record<Role, string> = {
  ORG_ADMIN: 'Organization Admin',
  TENANT_ADMIN: 'Tenant Admin',
  MEMBER: 'Customer',
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = body as { error?: string } | null
    throw Object.assign(new Error(error?.error ?? 'Request failed'), { status: response.status, body })
  }
  return body as T
}

function App() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [organizationId, setOrganizationId] = useState('')
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [tenantId, setTenantId] = useState('')
  const [boards, setBoards] = useState<Board[]>([])
  const [board, setBoard] = useState<BoardDetail | null>(null)
  const [activity, setActivity] = useState<Activity[]>([])
  const [socket, setSocket] = useState<Socket | null>(null)
  const [notice, setNotice] = useState('')
  const [modalTask, setModalTask] = useState<Task | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [dragTaskId, setDragTaskId] = useState('')

  useEffect(() => {
    api<{ user: AuthUser }>('/api/auth/me')
      .then(({ user: currentUser }) => setUser(currentUser))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!user) return
    api<{ organizations: Organization[] }>('/api/organizations')
      .then(({ organizations: data }) => {
        setOrganizations(data)
        setOrganizationId(user.organizationId)
      })
      .catch((error: Error) => setNotice(error.message))
  }, [user])

  useEffect(() => {
    if (!organizationId) return
    api<{ tenants: Tenant[] }>(`/api/organizations/${organizationId}/tenants`)
      .then(({ tenants: data }) => {
        setTenants(data)
        setTenantId((current) =>
          data.some((tenant) => tenant.id === current)
            ? current
            : user?.tenantId && data.some((tenant) => tenant.id === user.tenantId)
              ? user.tenantId
              : data[0]?.id ?? '',
        )
      })
      .catch((error: Error & { status?: number }) => {
        if (error.status === 403) setTenants([])
        setNotice(error.message)
      })
  }, [organizationId, user])

  useEffect(() => {
    if (!tenantId) {
      setBoards([])
      setBoard(null)
      setActivity([])
      return
    }
    setBoard(null)
    api<{ boards: Board[] }>(`/api/tenants/${tenantId}/boards`).then(({ boards: data }) => {
      setBoards(data)
      setBoard(null)
    }).catch((error: Error) => setNotice(error.message))
    api<{ activity: Activity[] }>(`/api/tenants/${tenantId}/activity`)
      .then(({ activity: data }) => setActivity(data))
      .catch(() => setActivity([]))
  }, [tenantId])

  useEffect(() => {
    if (!user) return
    const connection = io('http://localhost:3000', { withCredentials: true })
    setSocket(connection)
    connection.on('connect', () => {
      if (tenantId) connection.emit('tenant:join', { tenantId })
    })
    connection.on('socket:error', (payload: { error: string }) => setNotice(payload.error))
    connection.on('board:created', refreshBoards)
    connection.on('board:updated', refreshBoard)
    connection.on('board:deleted', refreshBoards)
    connection.on('column:created', refreshBoard)
    connection.on('column:updated', refreshBoard)
    connection.on('columns:reordered', refreshBoard)
    connection.on('column:deleted', refreshBoard)
    connection.on('task:created', refreshBoard)
    connection.on('task:updated', refreshBoard)
    connection.on('task:moved', refreshBoard)
    connection.on('task:deleted', refreshBoard)
    connection.on('disconnect', () => setNotice('Connection lost. Reconnecting...'))
    connection.on('connect', () => setNotice(''))
    return () => {
      connection.disconnect()
      setSocket(null)
    }
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!socket || !tenantId) return
    socket.emit('tenant:join', { tenantId })
  }, [socket, tenantId])

  function refreshBoards() {
    if (!tenantId) return
    api<{ boards: Board[] }>(`/api/tenants/${tenantId}/boards`)
      .then(({ boards: data }) => setBoards(data))
      .catch(() => undefined)
  }

  function refreshBoard() {
    if (!board) return
    api<{ board: BoardDetail }>(`/api/boards/${board.id}`)
      .then(({ board: data }) => setBoard(data))
      .catch(() => undefined)
  }

  async function login(event: FormEvent) {
    event.preventDefault()
    setLoginError('')
    setSubmitting(true)
    try {
      const result = await api<{ user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: identifier.trim(), password }),
      })
      setUser(result.user)
      setPassword('')
      window.history.replaceState({}, '', '/dashboard')
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined)
    setUser(null)
    setOrganizations([])
    setTenants([])
    setBoards([])
    setBoard(null)
    window.history.replaceState({}, '', '/login')
  }

  async function openBoard(boardId: string) {
    try {
      const result = await api<{ board: BoardDetail }>(`/api/boards/${boardId}`)
      setBoard(result.board)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not open board')
    }
  }

  async function createBoard() {
    if (!tenantId) return
    const name = window.prompt('Board name')
    if (!name?.trim()) return
    try {
      await api<{ board: Board }>(`/api/tenants/${tenantId}/boards`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      })
      refreshBoards()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create board')
    }
  }

  async function renameBoard() {
    if (!board) return
    const name = window.prompt('Rename board', board.name)
    if (!name?.trim()) return
    try {
      await api<{ board: Board }>(`/api/boards/${board.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      })
      refreshBoard()
      refreshBoards()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not rename board')
    }
  }

  async function deleteBoard() {
    if (!board || !window.confirm(`Delete board "${board.name}"?`)) return
    try {
      await api(`/api/boards/${board.id}`, { method: 'DELETE' })
      setBoard(null)
      refreshBoards()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete board')
    }
  }

  async function createColumn() {
    if (!board) return
    const name = window.prompt('Column name')
    if (!name?.trim()) return
    try {
      await api<{ column: Column }>(`/api/boards/${board.id}/columns`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      })
      refreshBoard()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create column')
    }
  }

  async function renameColumn(column: Column) {
    const name = window.prompt('Rename column', column.name)
    if (!name?.trim()) return
    try {
      await api<{ column: Column }>(`/api/columns/${column.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      })
      refreshBoard()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not rename column')
    }
  }

  async function deleteColumn(column: Column) {
    if (!window.confirm(`Delete column "${column.name}" and all of its tasks?`)) return
    try {
      await api(`/api/columns/${column.id}`, { method: 'DELETE' })
      refreshBoard()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete column')
    }
  }

  function openTask(task: Task) {
    setModalTask(task)
    setTaskTitle(task.title)
    setTaskDescription(task.description ?? '')
  }

  function closeTask() {
    setModalTask(null)
    setTaskTitle('')
    setTaskDescription('')
  }

  async function createTask(column: Column) {
    const title = window.prompt('Task title')
    if (!title?.trim()) return
    try {
      await api<{ task: Task }>(`/api/columns/${column.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title: title.trim(), description: '' }),
      })
      refreshBoard()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create task')
    }
  }

  async function saveTask(event: FormEvent) {
    event.preventDefault()
    if (!modalTask || !taskTitle.trim()) return
    try {
      const result = await api<{ task: Task }>(`/api/tasks/${modalTask.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: taskTitle.trim(),
          description: taskDescription,
          expectedVersion: modalTask.version,
        }),
      })
      setModalTask(result.task)
      closeTask()
      refreshBoard()
    } catch (error) {
      const status = (error as Error & { status?: number }).status
      if (status === 409) {
        setNotice('The task changed in another session. The latest server version will be loaded.')
        api<{ task: Task }>(`/api/tasks/${modalTask.id}`)
          .then(({ task }) => openTask(task))
          .catch(() => undefined)
      } else {
        setNotice(error instanceof Error ? error.message : 'Could not update task')
      }
    }
  }

  async function deleteTask() {
    if (!modalTask || !window.confirm(`Delete task "${modalTask.title}"?`)) return
    try {
      await api(`/api/tasks/${modalTask.id}`, { method: 'DELETE' })
      closeTask()
      refreshBoard()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete task')
    }
  }

  function onDragStart(event: DragEvent, taskId: string) {
    setDragTaskId(taskId)
    event.dataTransfer.effectAllowed = 'move'
  }

  async function onDrop(event: DragEvent, column: Column, position: number) {
    event.preventDefault()
    if (!dragTaskId || !board) return
    const task = board.columns.flatMap((item) => item.tasks).find((item) => item.id === dragTaskId)
    if (!task) return

    const previous = board
    setBoard((current) => {
      if (!current) return current
      const nextColumns = current.columns.map((item) => ({
        ...item,
        tasks: item.tasks.filter((itemTask) => itemTask.id !== dragTaskId),
      }))
      const target = nextColumns.find((item) => item.id === column.id)
      if (target) {
        target.tasks.splice(Math.min(position, target.tasks.length), 0, {
          ...task,
          columnId: column.id,
          position,
        })
      }
      return { ...current, columns: nextColumns }
    })
    setDragTaskId('')
    try {
      await api<{ task: Task }>(`/api/tasks/${task.id}/move`, {
        method: 'PATCH',
        body: JSON.stringify({ columnId: column.id, position, expectedVersion: task.version }),
      })
      refreshBoard()
    } catch (error) {
      setBoard(previous)
      setNotice(error instanceof Error ? error.message : 'Could not move task')
    }
  }

  async function switchOrganization(id: string) {
    setOrganizationId(id)
    setTenantId('')
    setBoard(null)
  }

  async function switchTenant(id: string) {
    if (socket) socket.emit('tenant:leave', { tenantId })
    setTenantId(id)
    setBoard(null)
  }

  if (loading) return <main className="loading-screen">Checking your session...</main>

  if (!user) {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-labelledby="login-title">
          <div className="brand-mark">TK</div>
          <p className="eyebrow">TENET KANBAN</p>
          <h1 id="login-title">Welcome back</h1>
          <p className="auth-subtitle">Sign in to continue to your workspace.</p>
          <form onSubmit={login}>
            <label htmlFor="identifier">Email or username</label>
            <input id="identifier" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" required />
            <label htmlFor="password">Password</label>
            <div className="password-field">
              <input id="password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
              <button type="button" className="show-password" onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? 'Hide' : 'Show'}</button>
            </div>
            {loginError && <p className="form-error" role="alert">{loginError}</p>}
            <button className="primary-button" type="submit" disabled={submitting}>{submitting ? 'Signing in...' : 'Sign in'}</button>
          </form>
        </section>
      </main>
    )
  }

  const canManage = user.role === 'ORG_ADMIN' || user.role === 'TENANT_ADMIN'

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="topbar-brand"><div className="brand-mark small">TK</div><strong>Tenet</strong></div>
        <div className="workspace-selectors">
          <select aria-label="Organization" value={organizationId} onChange={(event) => void switchOrganization(event.target.value)}>
            {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
          </select>
          <select aria-label="Tenant" value={tenantId} onChange={(event) => void switchTenant(event.target.value)} disabled={tenants.length === 0}>
            {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
          </select>
        </div>
        <div className="user-menu"><span>{user.username} · {roleLabels[user.role]}</span><button className="logout-button" type="button" onClick={() => void logout()}>Logout</button></div>
      </header>

      {notice && <div className="notice" role="alert">{notice}<button type="button" onClick={() => setNotice('')}>×</button></div>}

      <section className="kanban-layout">
        <aside className="board-sidebar">
          <div className="sidebar-heading"><h2>Boards</h2>{canManage && <button type="button" onClick={() => void createBoard()}>+</button>}</div>
          {boards.length === 0 ? <p className="empty-text">No boards in this tenant.</p> : boards.map((item) => (
            <button key={item.id} className={board?.id === item.id ? 'board-link active' : 'board-link'} type="button" onClick={() => void openBoard(item.id)}>{item.name}</button>
          ))}
        </aside>

        <section className="board-area">
          {!board ? (
            <div className="board-empty"><h1>Welcome, {user.username}</h1><p>You are logged in as {roleLabels[user.role]}.</p>{tenantId && boards[0] && <button className="primary-button" type="button" onClick={() => void openBoard(boards[0]!.id)}>Open {boards[0]!.name}</button>}</div>
          ) : (
            <>
              <div className="board-header">
                <h1>{board.name}</h1>
                {canManage && <div><button type="button" onClick={() => void renameBoard()}>Rename</button><button type="button" onClick={() => void deleteBoard()}>Delete</button></div>}
              </div>
              <div className="columns">
                {board.columns.map((column) => (
                  <section
                    className="column"
                    key={column.id}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => void onDrop(event, column, column.tasks.length)}
                  >
                    <div className="column-header">
                      <h2>{column.name}</h2>
                      {canManage && <div><button type="button" onClick={() => void renameColumn(column)}>Rename</button><button type="button" onClick={() => void deleteColumn(column)}>×</button></div>}
                    </div>
                    <div className="task-list">
                      {column.tasks.map((task, index) => (
                        <article
                          className="task-card"
                          key={task.id}
                          draggable
                          onDragStart={(event) => onDragStart(event, task.id)}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={(event) => void onDrop(event, column, index)}
                          onClick={() => openTask(task)}
                        >
                          <strong>{task.title}</strong>
                          {task.description && <p>{task.description}</p>}
                        </article>
                      ))}
                    </div>
                    <button className="add-task" type="button" onClick={() => void createTask(column)}>+ Add task</button>
                  </section>
                ))}
                {canManage && <button className="add-column" type="button" onClick={() => void createColumn()}>+ Add column</button>}
              </div>
              {activity.length > 0 && <details className="activity-panel"><summary>Recent activity</summary>{activity.slice(0, 15).map((item) => <div key={item.id}><strong>{item.action}</strong><span>{new Date(item.createdAt).toLocaleString()}</span></div>)}</details>}
            </>
          )}
        </section>
      </section>

      {modalTask && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeTask() }}>
          <section className="task-modal" role="dialog" aria-modal="true" aria-labelledby="task-title">
            <form onSubmit={saveTask}>
              <div className="modal-header"><h2 id="task-title">Task details</h2><button type="button" onClick={closeTask}>×</button></div>
              <label htmlFor="task-name">Title</label>
              <input id="task-name" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} required />
              <label htmlFor="task-description">Description</label>
              <textarea id="task-description" value={taskDescription} onChange={(event) => setTaskDescription(event.target.value)} rows={7} />
              <p className="version-label">Version {modalTask.version}</p>
              <div className="modal-actions"><button type="button" className="danger" onClick={() => void deleteTask()}>Delete</button><button type="submit" className="primary-button">Save</button></div>
            </form>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
