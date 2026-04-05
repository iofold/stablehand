# Workspace Tar API

This API allows external services to initialize or replace an agent's base workspace by uploading a compressed tarball. It's useful for pre-loading codebases, data files, or custom tools into an agent's environment.

## API Reference

### Upload Workspace Tarball
`POST /api/agents/:id/workspace`

Replaces the entire base workspace for the specified agent.

#### Request
- **Headers**: `Content-Type: application/gzip`
- **Body**: Raw `tar.gz` binary data.
- **Query Parameters**:
  - `force` (optional): Set to `true` to automatically kill any active sessions before replacing the workspace.

#### Response
- **201 Created**: Workspace replaced successfully.
  ```json
  {
    "files": 12,
    "totalBytes": 1048576
  }
  ```
- **400 Bad Request**: Extraction failed due to validation errors or the agent has no workspace configured.
- **409 Conflict**: The agent has active sessions. You must kill them first or use `?force=true`.
- **413 Payload Too Large**: The extracted content exceeds the system size limit (default 100 MB).
- **415 Unsupported Media Type**: The `Content-Type` header isn't `application/gzip`.

## Security Validation Rules

The system strictly validates every entry in the tarball to prevent security breaches. The upload will fail if any of these rules are broken:

- **No Absolute Paths**: Entries starting with `/` are rejected.
- **No Path Traversal**: Entries containing `../` are rejected.
- **No Symlinks or Hardlinks**: Only regular files and directories are allowed.
- **No Special Files**: Devices, sockets, and FIFOs are forbidden.
- **No Reserved Paths**: You can't write to `.git/` or `.ctxmill/` directories.
- **Size Limits**: The total extracted size must be under 100 MB. This limit is configurable in the system settings.
- **Target Confinement**: Files must stay within the agent's workspace directory.

## Tarball Structure

The workspace should contain the files your agent needs to function. Different harnesses look for specific directories:

- **Skills**: Place `SKILL.md` files in `.ctxmill/skills/`.
- **Claude Agents**: Configuration and hooks go in `.claude/`.
- **Custom Tools**: Define tools in a `tools/` directory if your agent is configured to load them from there.

Example layout:
```text
.
├── .ctxmill/
│   └── skills/
│       └── my-skill.md
├── tools/
│   └── custom-tool.ts
├── data/
│   └── dataset.csv
└── README.md
```

## Usage Examples

### Create a Tarball
Use the `tar` command to create a compatible archive. It's best to change into the workspace directory first so the paths are relative.

```bash
tar czf workspace.tar.gz -C ./my-workspace .
```

### Upload with curl
Send the raw binary data using the `--data-binary` flag.

```bash
curl -X POST http://localhost:3002/api/agents/agent-123/workspace \
  -H "Content-Type: application/gzip" \
  --data-binary @workspace.tar.gz
```

### Programmatic Upload (Node.js)
You can stream the file directly to the API.

```javascript
const fs = require('fs');
const axios = require('axios');

async function uploadWorkspace(agentId, filePath) {
  const stream = fs.createReadStream(filePath);
  await axios.post(`http://localhost:3002/api/agents/${agentId}/workspace`, stream, {
    headers: { 'Content-Type': 'application/gzip' }
  });
}
```

## Error Handling

| Error Message | Cause | Fix |
|---------------|-------|-----|
| `Agent has active sessions` | Sessions are currently using the workspace. | Kill active sessions or use `?force=true`. |
| `Absolute path rejected` | Tarball contains paths starting with `/`. | Re-create the tarball using relative paths. |
| `Path traversal rejected` | Tarball contains `../` segments. | Clean up the file structure before archiving. |
| `size exceeds ... bytes limit` | Extracted content is too large. | Remove unnecessary files or increase the limit in settings. |

## Workspace Lifecycle

1. **Initialization**: The base workspace is created when an agent is first registered or imported.
2. **Session Isolation**: When a new session starts, the system copies the base workspace into a session-specific directory.
3. **Persistence**: Changes made during a session stay in that session's directory. They don't affect the base workspace or other sessions.
4. **Promotion**: You can manually promote session changes back to the base workspace using the promote API.
5. **Replacement**: Uploading a new tarball completely replaces the base workspace. This is an atomic operation.
