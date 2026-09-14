import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveExtensionAssetUrl } from '@/renderer/utils/platform';

// Same asset the ExtensionSettingsPage iframe loads for the modes-console
// settings tab; resolveExtensionAssetUrl expands it to the aioncore origin in
// Electron (renderer is not same-origin with the backend) and leaves it
// relative under the WebUI reverse proxy.
const PANEL_URL = '/api/extensions/modes-console/assets/assets/index.html';

/**
 * Shell patch #2 (docs/shell-patches.md): full-size /modes page for the
 * orchestration console. Pure container — the panel itself is served by
 * aioncore and is not duplicated here.
 */
const ModesPage: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);

  return (
    <div className='relative w-full h-full min-h-0'>
      {loading && (
        <div className='absolute inset-0 flex items-center justify-center text-t-secondary text-14px'>
          <span className='animate-pulse'>Loading…</span>
        </div>
      )}
      <iframe
        src={resolveExtensionAssetUrl(PANEL_URL)}
        onLoad={() => setLoading(false)}
        sandbox='allow-scripts allow-same-origin'
        className='w-full h-full border-none'
        style={{
          opacity: loading ? 0 : 1,
          transition: 'opacity 150ms ease-in',
        }}
        title={t('common.modes')}
      />
    </div>
  );
};

export default ModesPage;
