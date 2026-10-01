import { useEffect } from "react";
import { useLocation, useParams, useSearch } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { FOLDER_SECTION_LIST, folderHref, type FolderSection } from "@shared/folder";

/** Old folder links (/folder/<key>): every patient's folder is now the Folder tab of their Patient 360. */
export default function FolderPage() {
  useAuth({ redirectOnUnauthenticated: true });
  const { key: raw } = useParams<{ key: string }>();
  const key = decodeURIComponent(raw ?? "");
  const section = new URLSearchParams(useSearch()).get("s");
  const initial = (FOLDER_SECTION_LIST as string[]).includes(section ?? "") ? (section as FolderSection) : null;
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation(folderHref(key, initial), { replace: true }); }, [key, initial, setLocation]);
  return null;
}
