"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context-integrated";
import { Button } from "@/components/ui/button";
import { ThinkingIndicator } from "@/components/ui/thinking-indicator";
import SharedContentView, { type SharedMessageView } from "@/components/share/SharedContentView";

type SharedChatPayload = {
    chat?: {
        title?: string;
        model?: string;
        messages?: SharedMessageView[];
    };
    sharedAt?: string;
};

export default function SharedChatPage() {
    const params = useParams();
    const shareId = params?.shareId;
    const { isAuthenticated } = useAuth();
    const tShare = useTranslations("sharePage");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<SharedChatPayload | null>(null);
    const [saving, setSaving] = useState(false);
    const saveStarted = useRef(false);

    useEffect(() => {
        const load = async () => {
            if (!shareId) {
                setError("invalid");
                setLoading(false);
                return;
            }
            try {
                const payload = await apiClient.shareChatIdLink(shareId as string);
                setData(payload);
            } catch (err: any) {
                console.error("[share] failed to load shared chat:", err);
                const status = err?.status || err?.statusCode;
                setError(status === 404 ? "notFound" : "loadFailed");
            } finally {
                setLoading(false);
            }
        };
        load();
    }, [shareId]);

    // Guardar en la cuenta es ahora una acción explícita del visitante —
    // nunca automática ni duplicada por re-montajes.
    const handleSaveToAccount = async () => {
        if (!data || saving || saveStarted.current) return;
        saveStarted.current = true;
        setSaving(true);
        try {
            const response = await apiClient.saveSharedContent(
                "complete",
                data,
                data.chat?.title,
            );
            if (response.success) {
                toast.success(tShare("saved"));
                window.location.href = `/chat?chatId=${response.chatId ?? ""}`;
            } else {
                toast.error(tShare("saveFailed"));
                saveStarted.current = false;
            }
        } catch (err: any) {
            const status = err?.status || err?.statusCode;
            if (status === 401) {
                toast.error(tShare("loginRequired"));
            } else {
                toast.error(tShare("saveFailed"));
                saveStarted.current = false;
            }
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="text-center space-y-4">
                    <ThinkingIndicator size="lg" className="mx-auto" />
                    <p className="text-muted-foreground">{tShare("loading")}</p>
                </div>
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="flex items-center justify-center min-h-screen px-4">
                <div className="text-center space-y-4 max-w-md">
                    <h1 className="text-xl font-semibold">
                        {error === "notFound" ? tShare("notFoundTitle") : tShare("errorTitle")}
                    </h1>
                    <p className="text-muted-foreground">
                        {error === "notFound" ? tShare("notFoundBody") : tShare("errorBody")}
                    </p>
                    <Button onClick={() => (window.location.href = "/chat")}>
                        {tShare("goHome")}
                    </Button>
                </div>
            </div>
        );
    }

    const messages = data.chat?.messages ?? [];

    return (
        <div>
            <SharedContentView
                title={data.chat?.title || tShare("defaultTitle")}
                subtitle={tShare("subtitleComplete", { count: messages.length })}
                messages={messages}
            />
            {/* Acción opcional: solo visitantes autenticados pueden guardar
                una copia; sin sesión, el enlace simplemente se lee. */}
            <div className="fixed inset-x-0 bottom-0 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
                <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
                    <p className="text-xs text-muted-foreground hidden sm:block">
                        {isAuthenticated ? tShare("saveHint") : tShare("readHint")}
                    </p>
                    {isAuthenticated ? (
                        <Button size="sm" onClick={handleSaveToAccount} disabled={saving}>
                            {saving ? tShare("saving") : tShare("saveToAccount")}
                        </Button>
                    ) : (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                                if (typeof window === "undefined") return;
                                window.location.href = `/auth/login?next=${encodeURIComponent(
                                    window.location.pathname,
                                )}`;
                            }}
                        >
                            {tShare("loginToSave")}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
