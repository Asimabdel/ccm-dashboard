import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { folderHref } from "@shared/folder";

/** Old chart links (/chart/:key): the chart now lives in the patient's folder. */
export default function ChartPage() {
  const { key: raw } = useParams<{ key: string }>();
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation(folderHref(decodeURIComponent(raw ?? ""), "chart"), { replace: true }); }, [raw, setLocation]);
  return null;
}
