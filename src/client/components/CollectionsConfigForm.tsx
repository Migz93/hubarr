import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPatch } from "../lib/api";
import type { CollectionSortOrder, PlexLibrary, VisibilityConfig } from "../../shared/types";
import { Field, SaveBar, SectionCard, SelectInput, TextInput, ToggleField } from "./FormControls";

interface CollectionsFormValue {
  collectionNamePattern: string;
  collectionSortOrder: CollectionSortOrder;
  movieLibraryId: string | null;
  showLibraryId: string | null;
  visibilityDefaults: VisibilityConfig;
}

export default function CollectionsConfigForm({
  initialValue,
  librariesUrl,
  onSaved,
  saveLabel = "Save Collections"
}: {
  initialValue: CollectionsFormValue;
  librariesUrl: string;
  onSaved?: (value: CollectionsFormValue) => void | Promise<void>;
  saveLabel?: string;
}) {
  const [form, setForm] = useState<CollectionsFormValue>(initialValue);
  const [libraries, setLibraries] = useState<PlexLibrary[]>([]);
  const [loadingLibraries, setLoadingLibraries] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(initialValue);
  }, [initialValue]);

  useEffect(() => {
    async function loadLibraries() {
      setLoadingLibraries(true);
      try {
        const result = await apiGet<PlexLibrary[]>(librariesUrl);
        setLibraries(result);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoadingLibraries(false);
      }
    }

    void loadLibraries();
  }, [librariesUrl]);

  const movieLibraries = useMemo(
    () => libraries.filter((library) => library.type === "movie"),
    [libraries]
  );
  const showLibraries = useMemo(
    () => libraries.filter((library) => library.type === "show"),
    [libraries]
  );

  async function save() {
    if (!form.movieLibraryId || !form.showLibraryId) {
      setError("Movie and TV libraries are both required.");
      return;
    }

    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      await apiPatch("/api/settings", { collections: form });
      setSuccess(true);
      await onSaved?.(form);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="Collections"
        description="Choose the default libraries, visibility, and naming pattern Hubarr will use when creating collections."
        wide
      >
        <Field
          label="Collection naming pattern"
          hint='Use {user} as a placeholder for the user name, for example "{user} Watchlist".'
        >
          <TextInput
            value={form.collectionNamePattern}
            onChange={(value) => setForm((current) => ({ ...current, collectionNamePattern: value }))}
          />
        </Field>

        <Field
          label="Collection ordering"
          hint="How items are sorted within each Hubarr collection in Plex."
        >
          <SelectInput
            value={form.collectionSortOrder}
            onChange={(value) =>
              setForm((current) => ({ ...current, collectionSortOrder: value as CollectionSortOrder }))
            }
          >
            <option value="year-desc">Release Year (New to Old)</option>
            <option value="year-asc">Release Year (Old to New)</option>
            <option value="title">Title (A–Z)</option>
          </SelectInput>
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Movie Library To Create Collection In">
            <SelectInput
              value={form.movieLibraryId ?? ""}
              onChange={(value) =>
                setForm((current) => ({ ...current, movieLibraryId: value || null }))
              }
            >
              <option value="">Select a movie library</option>
              {movieLibraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="TV Show Library To Create Collection In">
            <SelectInput
              value={form.showLibraryId ?? ""}
              onChange={(value) =>
                setForm((current) => ({ ...current, showLibraryId: value || null }))
              }
            >
              <option value="">Select a TV library</option>
              {showLibraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>

        {loadingLibraries && (
          <div className="text-xs text-on-surface-variant">Loading Plex libraries...</div>
        )}

        <div className="pt-2 border-t border-outline-variant/10">
          <div className="text-sm font-medium text-on-surface mb-3">Default Hub Visibility</div>
          <div className="space-y-3">
            <ToggleField
              label="Library Recommended"
              checked={form.visibilityDefaults.recommended}
              onChange={(value) =>
                setForm((current) => ({
                  ...current,
                  visibilityDefaults: { ...current.visibilityDefaults, recommended: value }
                }))
              }
            />
            <ToggleField
              label="Home"
              checked={form.visibilityDefaults.home}
              onChange={(value) =>
                setForm((current) => ({
                  ...current,
                  visibilityDefaults: { ...current.visibilityDefaults, home: value }
                }))
              }
            />
            <ToggleField
              label="Friends Home"
              checked={form.visibilityDefaults.shared}
              onChange={(value) =>
                setForm((current) => ({
                  ...current,
                  visibilityDefaults: { ...current.visibilityDefaults, shared: value }
                }))
              }
            />
          </div>
        </div>

        <SaveBar
          saving={saving}
          success={success}
          error={error}
          onSave={() => void save()}
          label={saveLabel}
        />
      </SectionCard>
    </div>
  );
}
