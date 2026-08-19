"use client"

import * as React from "react"
import { ChevronDown, Globe, BookOpen, Brain } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"

export interface SearchSources {
    scopus: boolean
    pubmed: boolean
    gpt4oMini: boolean
}

interface SearchSourceSelectorProps {
    sources: SearchSources
    onSourcesChange: (sources: SearchSources) => void
    disabled?: boolean
}

export default function SearchSourceSelector({
    sources,
    onSourcesChange,
    disabled = false
}: SearchSourceSelectorProps) {
    const [isOpen, setIsOpen] = React.useState(false)

    const handleSourceToggle = (source: keyof SearchSources) => {
        onSourcesChange({
            ...sources,
            [source]: !sources[source]
        })
    }

    const activeCount = Object.values(sources).filter(Boolean).length

    return (
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2 text-xs"
                    disabled={disabled}
                >
                    <Globe className="h-3 w-3" />
                    <span>Search Sources ({activeCount})</span>
                    <ChevronDown className="h-3 w-3" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 p-3">
                <div className="space-y-4">
                    <div className="text-sm font-medium text-foreground">
                        Select Search Sources
                    </div>

                    {/* Scopus */}
                    <div className="flex items-center justify-between space-x-3">
                        <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 rounded-lg bg-orange-100 dark:bg-orange-900/20 flex items-center justify-center">
                                <BookOpen className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                            </div>
                            <div className="flex-1">
                                <Label htmlFor="scopus-switch" className="text-sm font-medium cursor-pointer">
                                    Scopus
                                </Label>
                                <div className="text-xs text-muted-foreground">
                                    Academic database
                                </div>
                            </div>
                        </div>
                        <Switch
                            id="scopus-switch"
                            checked={sources.scopus}
                            onCheckedChange={() => handleSourceToggle('scopus')}
                            disabled={disabled}
                        />
                    </div>

                    {/* PubMed */}
                    <div className="flex items-center justify-between space-x-3">
                        <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center">
                                <BookOpen className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                            </div>
                            <div className="flex-1">
                                <Label htmlFor="pubmed-switch" className="text-sm font-medium cursor-pointer">
                                    PubMed
                                </Label>
                                <div className="text-xs text-muted-foreground">
                                    Medical literature
                                </div>
                            </div>
                        </div>
                        <Switch
                            id="pubmed-switch"
                            checked={sources.pubmed}
                            onCheckedChange={() => handleSourceToggle('pubmed')}
                            disabled={disabled}
                        />
                    </div>

                    {/* GPT-4o-mini-search */}
                    <div className="flex items-center justify-between space-x-3">
                        <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 rounded-lg bg-purple-100 dark:bg-purple-900/20 flex items-center justify-center">
                                <Brain className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                            </div>
                            <div className="flex-1">
                                <Label htmlFor="gpt4o-switch" className="text-sm font-medium cursor-pointer">
                                    GPT-4o-mini-search
                                </Label>
                                <div className="text-xs text-muted-foreground">
                                    AI-powered search
                                </div>
                            </div>
                        </div>
                        <Switch
                            id="gpt4o-switch"
                            checked={sources.gpt4oMini}
                            onCheckedChange={() => handleSourceToggle('gpt4oMini')}
                            disabled={disabled}
                        />
                    </div>

                    <div className="pt-2 border-t">
                        <div className="text-xs text-muted-foreground">
                            {activeCount === 0
                                ? "Select at least one source to search"
                                : `${activeCount} source${activeCount > 1 ? 's' : ''} selected`
                            }
                        </div>
                    </div>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
