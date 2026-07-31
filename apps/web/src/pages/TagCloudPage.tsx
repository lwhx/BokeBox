import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { coverImageUrl, fetchAllLibrary } from '../api/client';
import { StarMapLoader } from '../components/tags/StarMapLoader';
import type { TagStar } from '../components/tags/types';

const TagUniverse = lazy(() =>
  import('../components/tags/TagUniverse').then((m) => ({ default: m.TagUniverse })),
);
import { CoverArt } from '../components/ui/CoverArt';
import { EmptyState } from '../components/ui/EmptyState';
import { IconClose, IconPause, IconPlay, IconSearch, IconStars } from '../components/icons';
import { AppShell } from '../layouts/AppShell';
import { useI18n } from '../i18n';
import { getToken } from '../lib/auth';
import { navigate, type Route } from '../lib/router';
import { mergeListenRecord, bestResumeSec } from '../player/listenProgress';
import { usePlayer } from '../player/PlayerContext';
import { trackFromJob } from '../player/trackFromJob';
import type { LibraryItem } from '../types/job';

function itemTitle(item: LibraryItem): string {
  return item.job.podcast?.title || item.job.title;
}

function buildTagStars(library: LibraryItem[]): TagStar[] {
  const map = new Map<string, LibraryItem[]>();
  for (const item of library) {
    const tags = item.job.podcast?.tags || [];
    for (const raw of tags) {
      const name = String(raw || '').trim();
      if (!name) continue;
      const list = map.get(name) || [];
      list.push(item);
      map.set(name, list);
    }
  }
  return Array.from(map.entries())
    .map(([name, items]) => ({ name, count: items.length, items }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

export function TagCloudPage({ route }: { route: Route }) {
  const { t } = useI18n();
  const player = usePlayer();
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /** 与当前 tagKey 对齐后才算场景就绪，避免重建时闪黑 */
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [loaderFading, setLoaderFading] = useState(false);
  const [showLoader, setShowLoader] = useState(true);
  const fadeTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const lib = await fetchAllLibrary();
      const authed = Boolean(getToken());
      setLibrary(
        lib.map((it) => ({
          ...it,
          // 游客只合并本地进度
          listen: mergeListenRecord(it.job.id, authed ? it.listen : null),
        })),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tags = useMemo(() => buildTagStars(library), [library]);
  const active = useMemo(
    () => tags.find((x) => x.name === selected) || null,
    [tags, selected],
  );

  const visibleTags = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return tags;
    return tags.filter((tag) => tag.name.toLocaleLowerCase().includes(normalized));
  }, [query, tags]);

  const popularTags = useMemo(() => visibleTags.slice(0, 5), [visibleTags]);

  useEffect(() => {
    if (selected && !tags.some((x) => x.name === selected)) {
      setSelected(null);
    }
  }, [selected, tags]);

  const openItem = (item: LibraryItem) => {
    const listen = mergeListenRecord(item.job.id, item.listen);
    if (player.track?.id !== item.job.id) {
      player.playTrack(trackFromJob(item.job), {
        autoplay: true,
        resume: true,
        serverProgress: listen,
        seekTo: bestResumeSec(item.job.id, listen),
        queue: (active?.items || library).map((x) => trackFromJob(x.job)),
      });
    }
    navigate({ name: 'player', id: item.job.id });
  };

  const playItem = (item: LibraryItem) => {
    if (player.track?.id === item.job.id) {
      player.toggle();
      return;
    }
    const listen = mergeListenRecord(item.job.id, item.listen);
    player.playTrack(trackFromJob(item.job), {
      autoplay: true,
      resume: true,
      serverProgress: listen,
      seekTo: bestResumeSec(item.job.id, listen),
      queue: (active?.items || library).map((x) => trackFromJob(x.job)),
    });
  };

  const empty = !loading && tags.length === 0;
  const hasStars = tags.length > 0;
  const tagKey = useMemo(
    () => visibleTags.map((x) => `${x.name}:${x.count}`).join('|'),
    [visibleTags],
  );
  const sceneReady = hasStars && readyKey === tagKey;
  // 初次进入：数据请求或场景未就绪时展示加载动画
  const booting = loading || (hasStars && !sceneReady);

  useEffect(() => {
    if (booting) {
      setShowLoader(true);
      setLoaderFading(false);
      if (fadeTimerRef.current != null) {
        window.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
      return;
    }
    // 就绪后淡出再卸载，避免硬切
    setLoaderFading(true);
    fadeTimerRef.current = window.setTimeout(() => {
      setShowLoader(false);
      setLoaderFading(false);
      fadeTimerRef.current = null;
    }, 420);
    return () => {
      if (fadeTimerRef.current != null) {
        window.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
    };
  }, [booting]);

  const handleSceneReady = useCallback(() => {
    setReadyKey(tagKey);
  }, [tagKey]);

  return (
    <AppShell route={route} hideBottomNav={false}>
      <div className="tc-page">
        <div className="tc-universe">
          {!empty && hasStars ? (
            <Suspense fallback={null}>
            <TagUniverse
              tags={visibleTags}
              selected={selected}
              onSelect={setSelected}
              onReady={handleSceneReady}
            />
            </Suspense>
          ) : (
            <div className="tu-stage" aria-hidden>
              <div className="tu-vignette" />
            </div>
          )}

          {showLoader && (
            <StarMapLoader label={t('tags.loading')} fading={loaderFading} />
          )}

          <header className="tc-hud-top">
            <div className="tc-title-block">
              <div className="tc-kicker-row">
                <span className="tc-kicker-mark"><IconStars size={14} /></span>
                <span className="tc-kicker">{t('tags.kicker')}</span>
              </div>
              <h1 className="tc-title">
                {t('tags.title')}
                <span className="tc-title-en">{t('tags.titleEn')}</span>
              </h1>
              <p className="tc-sub">
                {loading ? t('tags.loading') : t('tags.description')}
              </p>
            </div>
            <div className="tc-hud-actions">
              <label className="tc-search">
                <IconSearch size={16} />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => {
                    const next = event.target.value;
                    setQuery(next);
                    if (selected && !tags.some((tag) => tag.name.toLocaleLowerCase().includes(next.trim().toLocaleLowerCase()))) {
                      setSelected(null);
                    }
                  }}
                  placeholder={t('tags.searchPlaceholder')}
                  aria-label={t('tags.searchPlaceholder')}
                />
              </label>
              <div className="tc-stat-strip" aria-label={t('tags.count', { n: tags.length, m: library.length })}>
                <span><b>{tags.length}</b>{t('tags.statsTags')}</span>
                <span><b>{library.length}</b>{t('tags.statsEpisodes')}</span>
                <span><b>{tags[0]?.count || 0}</b>{t('tags.statsTop')}</span>
              </div>
            </div>
          </header>

          {!empty && hasStars && (
            <aside className="tc-explorer" aria-label={t('tags.explorerTitle')}>
              <div className="tc-explorer-head">
                <div>
                  <span className="tc-section-label">{t('tags.explorerTitle')}</span>
                  <p>{t('tags.explorerDesc')}</p>
                </div>
                <span className="tc-explorer-index">01</span>
              </div>
              <div className="tc-explorer-divider" />
              <div className="tc-popular-title">
                <span>{t('tags.popular')}</span>
                <span>{visibleTags.length}/{tags.length}</span>
              </div>
              <div className="tc-popular-list">
                {popularTags.map((tag, index) => (
                  <button
                    key={tag.name}
                    type="button"
                    className={['tc-popular-item', selected === tag.name ? 'is-selected' : ''].join(' ')}
                    onClick={() => setSelected(selected === tag.name ? null : tag.name)}
                  >
                    <span className="tc-popular-rank">0{index + 1}</span>
                    <span className="tc-popular-name">{tag.name}</span>
                    <span className="tc-popular-count">{tag.count}</span>
                  </button>
                ))}
              </div>
              <div className="tc-explorer-foot">
                <IconStars size={14} />
                <span>{t('tags.mapLegend')}</span>
              </div>
            </aside>
          )}

          <div className="tc-hud-bottom">
            <span className="tc-hint">
              <b>{t('tags.mapHint')}</b> · {t('tags.hintClick')}
            </span>
            <span className="tc-meta">
              {selected
                ? t('tags.selected', { name: selected, n: active?.count || 0 })
                : t('tags.idle')}
            </span>
          </div>

          {error && <div className="tc-error">{error}</div>}

          {empty && (
            <div className="tc-empty">
              <EmptyState
                icon={<IconStars size={22} />}
                title={t('tags.emptyTitle')}
                description={t('tags.emptyDesc')}
                actionLabel={t('tags.emptyAction')}
                onAction={() => navigate({ name: 'create' })}
              />
            </div>
          )}
        </div>

        {active && (
          <aside className="tc-panel" aria-label={t('tags.panelAria')}>
            <button
              type="button"
              className="tc-panel-close"
              onClick={() => setSelected(null)}
              aria-label={t('common.close')}
            >
              <IconClose size={18} />
            </button>
            <div className="tc-panel-head">
              <span className="tc-panel-kicker">{t('tags.linked')}</span>
              <h2 className="tc-panel-title">{active.name}</h2>
              <p className="tc-panel-meta">{t('tags.linkedCount', { n: active.count })}</p>
            </div>
            <ul className="tc-panel-list">
              {active.items.map((item) => {
                const title = itemTitle(item);
                const playing = player.track?.id === item.job.id && player.playing;
                return (
                  <li key={item.job.id} className="tc-item">
                    <button
                      type="button"
                      className="tc-item-main"
                      onClick={() => openItem(item)}
                    >
                      <CoverArt
                        seed={item.job.id}
                        preferred={item.job.podcast?.coverGradient}
                        imageUrl={
                          item.job.podcast?.hasCoverImage
                            ? coverImageUrl(item.job.id, item.job.updatedAt)
                            : undefined
                        }
                        title={title}
                        className="tc-item-cover"
                        monogram={false}
                      />
                      <span className="tc-item-text">
                        <span className="tc-item-title">{title}</span>
                        <span className="tc-item-desc">
                          {item.job.podcast?.summary?.trim() ||
                            item.job.podcast?.hostIntro?.trim() ||
                            t('home.noSummary')}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={['tc-item-play', playing ? 'is-playing' : ''].join(' ')}
                      onClick={() => playItem(item)}
                      aria-label={
                        playing ? t('common.pause') : t('home.playTitle', { title })
                      }
                    >
                      {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        )}
      </div>
    </AppShell>
  );
}
