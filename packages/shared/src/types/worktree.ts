export interface SessionWorktree {
  id: string;
  session_id: string;
  worktree_name?: string;
  branch?: string;
  created_at: string;
  removed_at?: string;
  had_changes?: boolean;
  metadata?: Record<string, unknown>;
}
