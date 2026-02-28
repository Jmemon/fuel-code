/**
 * React hook that checks for updates on mount.
 * Returns UpdateInfo if an update is available, null otherwise.
 * Non-blocking — uses dynamic import to avoid loading update-checker at module time.
 */

import { useState, useEffect } from "react";
import type { UpdateInfo } from "../../lib/update-checker.js";

export function useUpdateCheck(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let mounted = true;
    // Dynamic import to avoid adding update-checker to the critical render path
    import("../../lib/update-checker.js")
      .then(({ checkForUpdate }) =>
        checkForUpdate().then((result) => {
          if (mounted && result) setUpdate(result);
        }),
      )
      .catch(() => {}); // Never block the TUI

    return () => {
      mounted = false;
    };
  }, []);

  return update;
}
