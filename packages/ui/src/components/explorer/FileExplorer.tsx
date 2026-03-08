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
} from 'lucide-react';
import { listFiles } from '@/lib/api';
import { cn } from '@/lib/utils';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
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
          'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors',
          'hover:bg-surface-700/50',
          isSelected && 'bg-brand-600/15 text-brand-300',
          !isSelected && 'text-surface-300',
        )}
        style={{ paddingLeft: `${depth * 16 + 6}px` }}
      >
        {/* Chevron for directories */}
        {isDir ? (
          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
            {node.loading ? (
              <Loader2 className="h-3 w-3 animate-spin text-surface-500" />
            ) : node.expanded ? (
              <ChevronDown className="h-3 w-3 text-surface-500" />
            ) : (
              <ChevronRight className="h-3 w-3 text-surface-500" />
            )}
          </span>
        ) : (
          <span className="h-4 w-4 flex-shrink-0" />
        )}

        {/* Icon */}
        <Icon
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0',
            isDir
              ? 'text-amber-400/80'
              : isSelected
                ? 'text-brand-400'
                : 'text-surface-500 group-hover:text-surface-400',
          )}
        />

        {/* Name */}
        <span className="truncate font-mono text-[11px]">{node.name}</span>
      </button>

      {/* Children */}
      {isDir && node.expanded && node.children && (
        <div>
          {/* Tree indent lines */}
          {node.children.map((child) => (
            <div key={child.path} className="relative">
              <div
                className="absolute top-0 bottom-0 border-l border-surface-700/40"
                style={{ left: `${(depth + 1) * 16 + 10}px` }}
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

export function FileExplorer({ agentId, onFileSelect, selectedFile }: FileExplorerProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rootLoading, setRootLoading] = useState(true);

  // Load root directory on mount
  useEffect(() => {
    let mounted = true;
    async function loadRoot() {
      setRootLoading(true);
      setError(null);
      try {
        const data = await listFiles(agentId, '.');
        if (!mounted) return;
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
        if (mounted) setError(String(err));
      } finally {
        if (mounted) setRootLoading(false);
      }
    }
    loadRoot();
    return () => {
      mounted = false;
    };
  }, [agentId]);

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
        const data = await listFiles(agentId, node.path);
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
    [agentId],
  );

  return (
    <div data-testid="file-explorer" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-surface-700/40 px-3 py-2">
        <Folder className="h-3.5 w-3.5 text-surface-400" />
        <span className="text-xs font-medium text-surface-300">Explorer</span>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-1 py-1">
        {rootLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-surface-500" />
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Failed to load files</span>
          </div>
        )}
        {!rootLoading && !error && tree.length === 0 && (
          <div className="px-3 py-4 text-xs text-surface-500">No files found</div>
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
