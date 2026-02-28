export interface SessionSkill {
  id: string;
  session_id: string;
  skill_name: string;
  invoked_at: string;
  invoked_by?: 'user' | 'claude';
  args?: string;
  metadata?: Record<string, unknown>;
}
