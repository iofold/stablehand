import { useEffect, useState } from 'react';
import {
  Wrench,
  ShieldCheck,
  Sparkles,
  Pencil,
  Trash2,
  X,
  FileCode,
  BookOpen,
  FolderArchive,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  fetchSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  type LoadedSkill,
  type LegacySkill,
} from '@/lib/api';

export interface AgentToolsTabProps {
  tools: string[];
  skills: string[];
  agentId: string;
}

function normalizeLoadedSkill(skill: LoadedSkill): LoadedSkill {
  return {
    ...skill,
    frontmatter: skill.frontmatter ?? { name: skill.name, description: skill.description },
    instructions: skill.instructions ?? '',
    scripts: Array.isArray(skill.scripts) ? skill.scripts : [],
    references: Array.isArray(skill.references) ? skill.references : [],
    assets: Array.isArray(skill.assets) ? skill.assets : [],
  };
}

export function AgentToolsTab({ tools = [], skills = [], agentId }: AgentToolsTabProps) {
  const [loadedSkills, setLoadedSkills] = useState<LoadedSkill[]>([]);
  const [legacySkills, setLegacySkills] = useState<LegacySkill[]>([]);
  const [showSkillForm, setShowSkillForm] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillDescription, setNewSkillDescription] = useState('');
  const [newSkillInstructions, setNewSkillInstructions] = useState('');
  const [creatingSkill, setCreatingSkill] = useState(false);

  // Edit state
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [savingSkill, setSavingSkill] = useState(false);

  // Expand state for instructions
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  // Delete confirmation state
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingSkill, setDeletingSkill] = useState(false);

  const loadSkills = async () => {
    try {
      const data = await fetchSkills(agentId);
      setLoadedSkills(Array.isArray(data.skills) ? data.skills.map(normalizeLoadedSkill) : []);
      setLegacySkills(Array.isArray(data.legacySkills) ? data.legacySkills : []);
    } catch {
      // silently fail
      setLoadedSkills([]);
      setLegacySkills([]);
    }
  };

  useEffect(() => {
    loadSkills();
  }, [agentId]);

  const handleCreateSkill = async () => {
    if (!newSkillName.trim() || !newSkillDescription.trim() || !newSkillInstructions.trim()) return;
    setCreatingSkill(true);
    try {
      await createSkill(agentId, {
        name: newSkillName.trim(),
        description: newSkillDescription.trim(),
        instructions: newSkillInstructions.trim(),
      });
      await loadSkills();
      setNewSkillName('');
      setNewSkillDescription('');
      setNewSkillInstructions('');
      setShowSkillForm(false);
    } catch {
      // silently fail
    } finally {
      setCreatingSkill(false);
    }
  };

  const handleEditSkill = (skill: LoadedSkill) => {
    setEditingSkill(skill.name);
    setEditDescription(skill.description);
    setEditInstructions(skill.instructions);
    setConfirmDelete(null);
  };

  const handleSaveSkill = async () => {
    if (!editingSkill) return;
    setSavingSkill(true);
    try {
      await updateSkill(agentId, editingSkill, {
        description: editDescription,
        instructions: editInstructions,
      });
      await loadSkills();
      setEditingSkill(null);
      setEditDescription('');
      setEditInstructions('');
    } catch {
      // silently fail
    } finally {
      setSavingSkill(false);
    }
  };

  const handleDeleteSkill = async (skillName: string) => {
    setDeletingSkill(true);
    try {
      await deleteSkill(agentId, skillName);
      await loadSkills();
      setConfirmDelete(null);
    } catch {
      // silently fail
    } finally {
      setDeletingSkill(false);
    }
  };

  const isHITL = (tool: string) =>
    /approve|hitl|human/i.test(tool);

  const toggleExpand = (name: string) => {
    setExpandedSkill(expandedSkill === name ? null : name);
  };

  return (
    <div data-testid="tools-explorer" className="space-y-8">
      {/* Tools section */}
      <div className="space-y-4">
      {tools.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-surface-400 font-medium">No tools configured</p>
          <p className="text-surface-600 text-sm mt-1">Configure tools in the agent definition to grant it capabilities.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {tools.map((tool) => (
            <div
              key={tool}
              data-testid="tool-detail-card"
              className="border border-surface-700 rounded-lg bg-surface-800 px-4 py-3 transition-colors hover:border-surface-600"
            >
              <div className="flex flex-col">
                <h4 className="font-mono text-sm font-medium text-surface-200">{tool}</h4>
                {isHITL(tool) && (
                  <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-300">
                    <ShieldCheck className="h-3 w-3" />
                    <span>Requires approval (HITL)</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      {/* Skills subsection */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent-400" />
            <h3 className="text-sm font-semibold text-surface-200">Skills</h3>
          </div>
          <button
            type="button"
            onClick={() => setShowSkillForm(!showSkillForm)}
            className="text-xs text-accent-400 hover:text-accent-300 transition-colors"
          >
            {showSkillForm ? 'Cancel' : '+ Create Skill'}
          </button>
        </div>

        {/* Create skill form */}
        {showSkillForm && (
          <div className="rounded-lg border border-accent-500/20 bg-surface-800/60 p-4 space-y-3">
            <input
              type="text"
              placeholder="skill-name (lowercase, hyphens only)"
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              className="w-full rounded-lg border border-surface-600/50 bg-surface-900/50 px-3 py-2 text-sm text-surface-200 placeholder:text-surface-600 focus:outline-none focus:border-accent-500/50"
            />
            <input
              type="text"
              placeholder="Short description"
              value={newSkillDescription}
              onChange={(e) => setNewSkillDescription(e.target.value)}
              className="w-full rounded-lg border border-surface-600/50 bg-surface-900/50 px-3 py-2 text-sm text-surface-200 placeholder:text-surface-600 focus:outline-none focus:border-accent-500/50"
            />
            <textarea
              placeholder="Instructions (markdown)..."
              value={newSkillInstructions}
              onChange={(e) => setNewSkillInstructions(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-surface-600/50 bg-surface-900/50 px-3 py-2 text-sm text-surface-200 placeholder:text-surface-600 focus:outline-none focus:border-accent-500/50 resize-none"
            />
            <button
              type="button"
              onClick={handleCreateSkill}
              disabled={creatingSkill || !newSkillName.trim() || !newSkillDescription.trim() || !newSkillInstructions.trim()}
              className="rounded-lg bg-accent-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creatingSkill ? 'Creating...' : 'Create'}
            </button>
          </div>
        )}

        {/* Standard skills (SKILL.md format) */}
        {loadedSkills.length > 0 && (
          <div className="grid grid-cols-1 gap-3">
            {loadedSkills.map((skill) => (
              <div
                key={skill.name}
                className="border border-surface-700 rounded-lg bg-surface-800 px-4 py-3 transition-colors hover:border-surface-600"
              >
                {editingSkill === skill.name ? (
                  /* Inline edit mode */
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-mono text-sm font-medium text-surface-200">{skill.name}</h4>
                      <button
                        type="button"
                        onClick={() => { setEditingSkill(null); setEditDescription(''); setEditInstructions(''); }}
                        className="text-surface-500 hover:text-surface-300 transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <input
                      type="text"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder="Description"
                      className="w-full rounded-lg border border-surface-600/50 bg-surface-900/50 px-3 py-2 text-sm text-surface-200 placeholder:text-surface-600 focus:outline-none focus:border-accent-500/50"
                    />
                    <textarea
                      value={editInstructions}
                      onChange={(e) => setEditInstructions(e.target.value)}
                      rows={8}
                      className="w-full rounded-lg border border-surface-600/50 bg-surface-900/50 px-3 py-2 text-sm text-surface-200 font-mono focus:outline-none focus:border-accent-500/50 resize-none"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSaveSkill}
                        disabled={savingSkill}
                        className="rounded-lg bg-accent-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {savingSkill ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditingSkill(null); setEditDescription(''); setEditInstructions(''); }}
                        className="rounded-lg border border-surface-600 px-4 py-1.5 text-xs font-medium text-surface-300 hover:border-surface-500 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : confirmDelete === skill.name ? (
                  /* Delete confirmation mode */
                  <div className="space-y-3">
                    <p className="text-sm text-surface-300">
                      Delete <span className="font-mono font-medium text-surface-200">{skill.name}</span>?
                      This removes the entire skill directory.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleDeleteSkill(skill.name)}
                        disabled={deletingSkill}
                        className="rounded-lg bg-red-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {deletingSkill ? 'Deleting...' : 'Confirm Delete'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                        className="rounded-lg border border-surface-600 px-4 py-1.5 text-xs font-medium text-surface-300 hover:border-surface-500 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Normal display mode */
                  <div className="flex flex-col">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="font-mono text-sm font-medium text-surface-200">{skill.name}</h4>
                          {skill.frontmatter?.['allowed-tools'] && (
                            <span className="text-[10px] text-surface-500 bg-surface-700/50 px-1.5 py-0.5 rounded">
                              {skill.frontmatter['allowed-tools'].split(' ').length} tools
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-surface-400 mt-1">{skill.description}</p>
                      </div>
                      <div className="flex items-center gap-1 ml-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleEditSkill(skill)}
                          title="Edit skill"
                          className="p-1 text-surface-500 hover:text-accent-400 transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { setConfirmDelete(skill.name); setEditingSkill(null); }}
                          title="Delete skill"
                          className="p-1 text-surface-500 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Directory contents summary */}
                    <div className="mt-2 flex items-center gap-3 text-[11px] text-surface-500">
                      {skill.scripts.length > 0 && (
                        <span className="flex items-center gap-1">
                          <FileCode className="h-3 w-3" />
                          {skill.scripts.length} script{skill.scripts.length !== 1 ? 's' : ''}
                        </span>
                      )}
                      {skill.references.length > 0 && (
                        <span className="flex items-center gap-1">
                          <BookOpen className="h-3 w-3" />
                          {skill.references.length} ref{skill.references.length !== 1 ? 's' : ''}
                        </span>
                      )}
                      {skill.assets.length > 0 && (
                        <span className="flex items-center gap-1">
                          <FolderArchive className="h-3 w-3" />
                          {skill.assets.length} asset{skill.assets.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>

                    {/* Expandable instructions */}
                    {skill.instructions && (
                      <button
                        type="button"
                        onClick={() => toggleExpand(skill.name)}
                        className="mt-2 flex items-center gap-1 text-[11px] text-surface-500 hover:text-surface-300 transition-colors"
                      >
                        {expandedSkill === skill.name ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        Instructions
                      </button>
                    )}
                    {expandedSkill === skill.name && skill.instructions && (
                      <div className="mt-2 rounded-md bg-surface-900/50 border border-surface-700/50 px-3 py-2 text-xs text-surface-300 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                        {skill.instructions}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Legacy skills (backward compat) */}
        {legacySkills.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] text-surface-500 uppercase tracking-wide">Legacy Skills</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {legacySkills.map((skill) => (
                <div
                  key={skill.filename}
                  className="border border-surface-700/50 rounded-lg bg-surface-800/50 px-4 py-3 transition-colors hover:border-surface-600"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-mono text-sm font-medium text-surface-200">{skill.name}</h4>
                      <div className="mt-1 text-[11px] text-surface-500 font-mono truncate">
                        {skill.filename}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirmDelete === skill.name) {
                          handleDeleteSkill(skill.name);
                        } else {
                          setConfirmDelete(skill.name);
                        }
                      }}
                      title="Delete legacy skill"
                      className="p-1 text-surface-500 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="text-sm text-surface-400 mt-1 line-clamp-2">{skill.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Fallback: show skill names from agent definition when no files loaded */}
        {loadedSkills.length === 0 && legacySkills.length === 0 && skills.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {skills.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center gap-1.5 rounded-full border border-accent-500/20 bg-accent-600/10 px-3 py-1 text-xs font-medium text-accent-300"
              >
                <Sparkles className="h-3 w-3 text-accent-400" />
                {skill}
              </span>
            ))}
          </div>
        )}

        {/* Empty state */}
        {loadedSkills.length === 0 && legacySkills.length === 0 && skills.length === 0 && (
          <p className="text-sm text-surface-500">
            No skills configured. Skills are higher-level capabilities that compose tools.
          </p>
        )}
      </div>
    </div>
  );
}
