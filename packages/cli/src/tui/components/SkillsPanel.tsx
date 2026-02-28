/**
 * SkillsPanel — displays skills invoked during a session in the sidebar.
 *
 * User-invoked skills are shown with a "/" prefix; auto-detected skills show
 * without it. Each row shows the skill name, invocation source, and time.
 *
 * Returns null when there are no skills.
 */

import React from "react";
import { Box, Text } from "ink";
import type { SessionSkill } from "@fuel-code/shared";

export interface SkillsPanelProps {
  skills: SessionSkill[];
}

/** Format an ISO timestamp into a short time string like "2:45 PM". */
function formatSkillTime(isoTimestamp: string): string {
  try {
    const d = new Date(isoTimestamp);
    const hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    const h12 = hours % 12 || 12;
    return `${h12}:${minutes} ${ampm}`;
  } catch {
    return "";
  }
}

export function SkillsPanel({ skills }: SkillsPanelProps): React.ReactElement | null {
  if (skills.length === 0) return null;

  return (
    <Box flexDirection="column">
      <Text bold>Skills ({skills.length})</Text>
      {skills.map((skill) => {
        const isUser = skill.invoked_by === "user";
        const displayName = isUser ? `/${skill.skill_name}` : skill.skill_name;
        const sourceLabel = isUser ? "(user)" : "(auto)";
        const time = formatSkillTime(skill.invoked_at);

        return (
          <Box key={skill.id}>
            <Text> {displayName}</Text>
            <Text>{"  "}</Text>
            <Text dimColor>{sourceLabel}</Text>
            <Text>{"  "}</Text>
            <Text dimColor>{time}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
