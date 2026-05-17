// TaskMaster AI — Tasks API
// Runs on Vercel, stores tasks in GitHub as tasks.json

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g. "yourusername/taskmaster"
const TASKS_FILE = 'tasks.json';
const API_SECRET = process.env.API_SECRET; // simple auth key

const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/contents/${TASKS_FILE}`;

// ── Helpers ──
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
  const body = {
    message: `TaskMaster sync — ${new Date().toISOString()}`,
    content,
    ...(sha ? { sha } : {})
  };

  const res = await fetch(GITHUB_API, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  return res.ok;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-secret',
    'Content-Type': 'application/json'
  };
}

function unauthorized() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: corsHeaders()
  });
}

// ── Main Handler ──
export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Auth check
  const secret = req.headers.get('x-api-secret');
  if (API_SECRET && secret !== API_SECRET) return unauthorized();

  const url = new URL(req.url);
  const method = req.method;

  try {
    // GET /api/tasks — get all tasks
    if (method === 'GET') {
      const { tasks } = await getTasksFromGitHub();
      return new Response(JSON.stringify({ tasks }), {
        status: 200, headers: corsHeaders()
      });
    }

    // POST /api/tasks — add a new task
    if (method === 'POST') {
      const body = await req.json();
      const { tasks, sha } = await getTasksFromGitHub();

      const newTask = {
        id: Date.now().toString(),
        title: body.title,
        priority: body.priority || 'med',
        category: body.category || 'work',
        done: false,
        remind: body.remind || null,
        calEventId: body.calEventId || null,
        created: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        source: body.source || 'claude' // track who created it
      };

      tasks.unshift(newTask);
      const ok = await saveTasksToGitHub(tasks, sha);

      return new Response(JSON.stringify({ success: ok, task: newTask }), {
        status: ok ? 201 : 500, headers: corsHeaders()
      });
    }

    // PATCH /api/tasks — update a task (mark done, change priority, etc)
    if (method === 'PATCH') {
      const body = await req.json();
      const { tasks, sha } = await getTasksFromGitHub();

      const idx = tasks.findIndex(t => t.id === body.id);
      if (idx === -1) {
        return new Response(JSON.stringify({ error: 'Task not found' }), {
          status: 404, headers: corsHeaders()
        });
      }

      tasks[idx] = {
        ...tasks[idx],
        ...body,
        updatedAt: new Date().toISOString(),
        completedAt: body.done && !tasks[idx].done ? new Date().toISOString() : tasks[idx].completedAt
      };

      const ok = await saveTasksToGitHub(tasks, sha);
      return new Response(JSON.stringify({ success: ok, task: tasks[idx] }), {
        status: ok ? 200 : 500, headers: corsHeaders()
      });
    }

    // DELETE /api/tasks?id=xxx — delete a task
    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      const { tasks, sha } = await getTasksFromGitHub();
      const filtered = tasks.filter(t => t.id !== id);
      const ok = await saveTasksToGitHub(filtered, sha);

      return new Response(JSON.stringify({ success: ok }), {
        status: ok ? 200 : 500, headers: corsHeaders()
      });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: corsHeaders()
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: corsHeaders()
    });
  }
}

export const config = { runtime: 'edge' };
