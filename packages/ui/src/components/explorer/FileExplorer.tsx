import { useState, useCallback, useEffect } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  FileJson,
  File,
  Loader2,
  AlertCircle,
  Plus,
  X,
} from 'lucide-react';
import { listFiles, createFile } from '@/lib/api';
import { cn } from '@/lib/utils';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  sizeBytes: number;
}

interface TreeNode extends FileEntry {
  path: string;
  children?: TreeNode[];
  loaded?: boolean;
  loading?: boolean;
  expanded?: boolean;
}

interface FileExplorerProps {
  agentId: string;
  onFileSelect: (path: string) => void;
  selectedFile?: string | null;
  /** When provided, files are served from the conversation workspace instead of base workspace */
  conversationId?: string;
  /** Called after a file is created so the parent can react (e.g. select the new file) */
  onFileCreated?: (path: string) => void;
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
    case 'rs':
    case 'go':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'sh':
    case 'bash':
      return FileCode;
    case 'json':
    case 'jsonl':
    case 'ndjson':
      return FileJson;
    case 'md':
    case 'txt':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'cfg':
    case 'env':
    case 'csv':
      return FileText;
    default:
      return File;
  }
}

function TreeItem({
  node,
  depth,
  onToggle,
  onSelect,
  selectedFile,
}: {
  node: TreeNode;
  depth: number;
  onToggle: (node: TreeNode) => void;
  onSelect: (path: string) => void;
  selectedFile?: string | null;
}) {
  const isDir = node.type === 'directory';
  const isSelected = !isDir && node.path === selectedFile;
  const Icon = isDir
    ? node.expanded
      ? FolderOpen
      : Folder
    : getFileIcon(node.name);

  return (
    <div>
      <button
        type="button"
        data-testid="file-tree-item"
        data-path={node.path}
        onClick={() => {
          if (isDir) {
            onToggle(node);
          } else {
            onSelect(node.path);
          }
        }}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-sm cursor-pointer',
          'hover:bg-surface-800 hover:text-surface-200',
          isSelected ? 'bg-surface-800 text-surface-100' : 'text-surface-400',
        )}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {/* Chevron for directories */}
        {isDir ? (
          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
            {node.loading ? (
              <Loader2 className="h-3 w-3 animate-spin text-surface-400" />
            ) : node.expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-surface-400" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-surface-400" />
            )}
          </span>
        ) : (
          <span className="h-4 w-4 flex-shrink-0" />
        )}

        {/* Icon */}
        <Icon
          className={cn(
            'h-4 w-4 flex-shrink-0',
            isDir
              ? 'text-surface-400'
              : isSelected
                ? 'text-surface-100'
                : 'text-surface-400 group-hover:text-surface-300',
          )}
        />

        {/* Name */}
        <span className="truncate font-mono">{node.name}</span>
      </button>

      {/* Children */}
      {isDir && node.expanded && node.children && (
        <div>
          {/* Tree indent lines */}
          {node.children.map((child) => (
            <div key={child.path} className="relative">
              <div
                className="absolute top-0 bottom-0 border-l border-surface-700/50"
                style={{ left: `${(depth + 1) * 16 + 20}px` }}
              />
              <TreeItem
                node={child}
                depth={depth + 1}
                onToggle={onToggle}
                onSelect={onSelect}
                selectedFile={selectedFile}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ agentId, onFileSelect, selectedFile, conversationId, onFileCreated }: FileExplorerProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rootLoading, setRootLoading] = useState(true);
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Load root directory on mount
  const loadRoot = useCallback(async () => {
    setRootLoading(true);
    setError(null);
    try {
      const data = await listFiles(agentId, '.', conversationId);
      const entries: FileEntry[] = data.entries || [];
      const sorted = sortEntries(entries);
      setTree(
        sorted.map((e) => ({
          ...e,
          path: e.name,
          children: e.type === 'directory' ? [] : undefined,
          loaded: false,
          expanded: false,
          loading: false,
        })),
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setRootLoading(false);
    }
  }, [agentId, conversationId]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  const handleToggle = useCallback(
    async (node: TreeNode) => {
      if (node.expanded) {
        // Collapse
        setTree((prev) => updateNode(prev, node.path, { expanded: false }));
        return;
      }

      if (node.loaded) {
        // Already loaded, just expand
        setTree((prev) => updateNode(prev, node.path, { expanded: true }));
        return;
      }

      // Load children
      setTree((prev) => updateNode(prev, node.path, { loading: true, expanded: true }));
      try {
        const data = await listFiles(agentId, node.path, conversationId);
        const entries: FileEntry[] = data.entries || [];
        const sorted = sortEntries(entries);
        const children: TreeNode[] = sorted.map((e) => ({
          ...e,
          path: `${node.path}/${e.name}`,
          children: e.type === 'directory' ? [] : undefined,
          loaded: false,
          expanded: false,
          loading: false,
        }));
        setTree((prev) =>
          updateNode(prev, node.path, { children, loaded: true, loading: false }),
        );
      } catch (err) {
        console.debug('[FileExplorer] Failed to load directory:', err);
        setTree((prev) => updateNode(prev, node.path, { loading: false }));
      }
    },
    [agentId, conversationId],
  );

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const createdPath = newFileName.trim();
      await createFile(agentId, createdPath, newFileContent, conversationId);
      setShowNewFile(false);
      setNewFileName('');
      setNewFileContent('');
      // Refresh the tree and select the new file
      await loadRoot();
      onFileCreated?.(createdPath);
      onFileSelect(createdPath);
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div data-testid="file-explorer" className="flex h-full flex-col bg-surface-850 border-r border-surface-700">
      {/* Header with New File button */}
      <div className="flex items-center justify-between border-b border-surface-700 px-3 py-2">
        <span className="text-xs font-medium text-surface-400">
          {conversationId ? 'Conversation Files' : 'Files'}
        </span>
        <button
          type="button"
          data-testid="new-file-btn"
          onClick={() => setShowNewFile(true)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-surface-400 hover:bg-surface-800 hover:text-surface-200 transition-colors"
          title={conversationId ? 'New file in conversation workspace' : 'New file'}
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New</span>
        </button>
      </div>

      {/* New File Modal */}
      {showNewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowNewFile(false)}>
          <div
            className="w-full max-w-lg rounded-lg border border-surface-700 bg-surface-900 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-surface-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-surface-200">Create New File</h3>
              <button
                type="button"
                onClick={() => setShowNewFile(false)}
                className="rounded-md p-1 text-surface-400 hover:bg-surface-800 hover:text-surface-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 p-4">
              <div>
                <label className="block text-xs font-medium text-surface-400 mb-1">File path</label>
                <input
                  data-testid="new-file-path"
                  type="text"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  placeholder="e.g. src/utils.ts"
                  className="w-full rounded-md border border-surface-700 bg-surface-850 px-3 py-2 font-mono text-sm text-surface-200 placeholder:text-surface-400 focus:border-surface-500 focus:outline-none"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-surface-400 mb-1">Content</label>
                <textarea
                  data-testid="new-file-content"
                  value={newFileContent}
                  onChange={(e) => setNewFileContent(e.target.value)}
                  placeholder="File contents..."
                  rows={12}
                  className="w-full rounded-md border border-surface-700 bg-surface-850 px-3 py-2 font-mono text-sm text-surface-200 placeholder:text-surface-400 focus:border-surface-500 focus:outline-none resize-y"
                />
              </div>
              {createError && (
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>{createError}</span>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowNewFile(false)}
                  className="rounded-md px-3 py-1.5 text-sm text-surface-400 hover:text-surface-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="create-file-submit"
                  onClick={handleCreateFile}
                  disabled={!newFileName.trim() || creating}
                  className="flex items-center gap-1.5 rounded-md bg-surface-700 px-3 py-1.5 text-sm font-medium text-surface-200 hover:bg-surface-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-1 py-1">
        {rootLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-surface-400" />
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Failed to load files</span>
          </div>
        )}
        {!rootLoading && !error && tree.length === 0 && (
          <div className="px-3 py-4 text-xs text-surface-400">No files found</div>
        )}
        {tree.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            onToggle={handleToggle}
            onSelect={onFileSelect}
            selectedFile={selectedFile}
          />
        ))}
      </div>
    </div>
  );
}

/** Sort entries: directories first, then alphabetical */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Recursively update a node by path in the tree */
function updateNode(
  nodes: TreeNode[],
  path: string,
  updates: Partial<TreeNode>,
): TreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) {
      return { ...n, ...updates };
    }
    if (n.children && path.startsWith(n.path + '/')) {
      return { ...n, children: updateNode(n.children, path, updates) };
    }
    return n;
  });
}
