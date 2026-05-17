// TaskMaster AI — MCP Server Endpoint
// Implements the Model Context Protocol so Claude can call this directly

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const TASKS_FILE = 'tasks.json';
const API_SECRET = process.env.API_SECRET;
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/contents/${TASKS_FILE}`;

// ── GitHub helpers (same as tasks.js) ──
async function getTasksFromGitHub() {
  const res = await fetch(GITHUB_API, {
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json'
    }
  });
  if (res.status === 404) return { tasks: [], sha: null };
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { tasks: JSON.parse(content), sha: data.sha };
}

async function saveTasksToGitHub(tasks, sha) {
  const content = Buffer.from(JSON.stringify(tasks, null, 2)).toString('base64');
  const res = await fetch(GITHUB_API, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `TaskMaster MCP sync — ${new Date().toISOString()}`,
      content,
      ...(sha ? { sha } : {})
    })
  });
  return res.ok;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
}

// ── MCP Tool Definitions ──
const TOOLS = [
  {
    name: 'add_task',
    description: 'Add a new task to the TaskMaster todo list. Use this whenever the user mentions a task, action item, or to-do.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The task description' },
        priority: { type: 'string', enum: ['high', 'med', 'low'], description: 'Task priority' },
        category: { type: 'string', enum: ['work', 'email', 'code'], description: 'Task category' },
        remind: { type: 'string', description: 'Optional reminder datetime in ISO 8601 format' },
        calEventId: { type: 'string', description: 'Optional Google Calendar event ID if one was created' }
      },
      required: ['title', 'priority', 'category']
    }
  },
  {
    name: 'get_tasks',
    description: 'Get all tasks from the TaskMaster todo list. Use this to show the user their current tasks or check what is pending.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'pending', 'done', 'high', 'med', 'low'], description: 'Filter tasks by status or priority' }
      }
    }
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done in the TaskMaster todo list.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID to mark as complete' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_task',
    description: 'Delete a task from the TaskMaster todo list.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID to delete' }
      },
      required: ['id']
    }
  },
  {
    name: 'update_task',
    description: 'Update an existing task — change priority, category, title or reminder.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID to update' },
        title: { type: 'string', description: 'New title (optional)' },
        priority: { type: 'string', enum: ['high', 'med', 'low'], description: 'New priority (optional)' },
        category: { type: 'string', enum: ['work', 'email', 'code'], description: 'New category (optional)' },
        remind: { type: 'string', description: 'New reminder datetime (optional)' }
      },
      required: ['id']
    }
  }
];

// ── Tool Execution ──
async function executeTool(name, input) {
  const { tasks, sha } = await getTasksFromGitHub();

  if (name === 'get_tasks') {
    const filter = input.filter || 'all';
    let filtered = tasks;
    if (filter === 'pending') filtered = tasks.filter(t => !t.done);
    else if (filter === 'done') filtered = tasks.filter(t => t.done);
    else if (['high', 'med', 'low'].includes(filter)) filtered = tasks.filter(t => t.priority === filter && !t.done);

    if (filtered.length === 0) return { content: [{ type: 'text', text: 'No tasks found.' }] };

    const lines = filtered.map(t => {
      const pri = { high: '🔴', med: '🟡', low: '🟢' }[t.priority] || '🟡';
      const cat = { work: '💼', email: '📧', code: '💻' }[t.category] || '💼';
      const status = t.done ? '✅' : '⬜';
      const remind = t.remind ? ` ⏰ ${t.remind}` : '';
      return `${status} ${pri} ${cat} [${t.id}] ${t.title}${remind}`;
    }).join('\n');

    return { content: [{ type: 'text', text: lines }] };
  }

  if (name === 'add_task') {
    const newTask = {
      id: Date.now().toString(),
      title: input.title,
      priority: input.priority || 'med',
      category: input.category || 'work',
      done: false,
      remind: input.remind || null,
      calEventId: input.calEventId || null,
      created: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      source: 'claude'
    };
    tasks.unshift(newTask);
    const ok = await saveTasksToGitHub(tasks, sha);
    if (!ok) return { content: [{ type: 'text', text: '❌ Failed to save task.' }], isError: true };
    return { content: [{ type: 'text', text: `✅ Task added: "${newTask.title}" [ID: ${newTask.id}]` }] };
  }

  if (name === 'complete_task') {
    const idx = tasks.findIndex(t => t.id === input.id);
    if (idx === -1) return { content: [{ type: 'text', text: `❌ Task ID ${input.id} not found.` }], isError: true };
    tasks[idx].done = true;
    tasks[idx].completedAt = new Date().toISOString();
    tasks[idx].updatedAt = new Date().toISOString();
    const ok = await saveTasksToGitHub(tasks, sha);
    if (!ok) return { content: [{ type: 'text', text: '❌ Failed to update task.' }], isError: true };
    return { content: [{ type: 'text', text: `✅ Task completed: "${tasks[idx].title}"` }] };
  }

  if (name === 'delete_task') {
    const idx = tasks.findIndex(t => t.id === input.id);
    if (idx === -1) return { content: [{ type: 'text', text: `❌ Task ID ${input.id} not found.` }], isError: true };
    const title = tasks[idx].title;
    tasks.splice(idx, 1);
    const ok = await saveTasksToGitHub(tasks, sha);
    if (!ok) return { content: [{ type: 'text', text: '❌ Failed to delete task.' }], isError: true };
    return { content: [{ type: 'text', text: `✅ Task deleted: "${title}"` }] };
  }

  if (name === 'update_task') {
    const idx = tasks.findIndex(t => t.id === input.id);
    if (idx === -1) return { content: [{ type: 'text', text: `❌ Task ID ${input.id} not found.` }], isError: true };
    if (input.title) tasks[idx].title = input.title;
    if (input.priority) tasks[idx].priority = input.priority;
    if (input.category) tasks[idx].category = input.category;
    if (input.remind !== undefined) tasks[idx].remind = input.remind;
    tasks[idx].updatedAt = new Date().toISOString();
    const ok = await saveTasksToGitHub(tasks, sha);
    if (!ok) return { content: [{ type: 'text', text: '❌ Failed to update task.' }], isError: true };
    return { content: [{ type: 'text', text: `✅ Task updated: "${tasks[idx].title}"` }] };
  }

  return { content: [{ type: 'text', text: `❌ Unknown tool: ${name}` }], isError: true };
}

// ── MCP Protocol Handler ──
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Auth
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (API_SECRET && token !== API_SECRET) {
    return new Response(JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'Unauthorized' }
    }), { status: 401, headers: corsHeaders() });
  }

  // SSE endpoint for MCP
  if (req.method === 'GET') {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send server info
        const info = {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {
            serverInfo: { name: 'TaskMaster AI', version: '1.0.0' },
            capabilities: { tools: {} }
          }
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(info)}\n\n`));
      }
    });
    return new Response(stream, {
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'Parse error' }
      }), { status: 400, headers: corsHeaders() });
    }

    const { id, method, params } = body;

    // Initialize
    if (method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'TaskMaster AI', version: '1.0.0' },
          capabilities: { tools: {} }
        }
      }), { status: 200, headers: corsHeaders() });
    }

    // List tools
    if (method === 'tools/list') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id,
        result: { tools: TOOLS }
      }), { status: 200, headers: corsHeaders() });
    }

    // Call tool
    if (method === 'tools/call') {
      try {
        const result = await executeTool(params.name, params.arguments || {});
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id, result
        }), { status: 200, headers: corsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id,
          error: { code: -32000, message: e.message }
        }), { status: 500, headers: corsHeaders() });
      }
    }

    // Notifications (no response needed)
    if (method.startsWith('notifications/')) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    return new Response(JSON.stringify({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: 'Method not found' }
    }), { status: 404, headers: corsHeaders() });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405, headers: corsHeaders()
  });
}

export const config = { runtime: 'edge' };
