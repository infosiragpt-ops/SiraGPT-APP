"use client"

import React, { useState } from 'react'
import { 
  Settings, 
  Shield, 
  Clock, 
  Monitor,
  AlertTriangle,
  Check,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogFooter, 
  DialogHeader, 
  DialogTitle,
  DialogTrigger 
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

interface ComputerUseSettingsProps {
  onSettingsChange?: (settings: ComputerUseSettings) => void
}

interface ComputerUseSettings {
  safetyMode: 'strict' | 'balanced' | 'permissive'
  autoConfirmSafe: boolean
  sessionTimeout: number // in minutes
  screenshotQuality: number // 1-100
  enableDetailedLogging: boolean
  blockSensitiveDomains: boolean
  maxActionsPerSession: number
}

const ComputerUseSettings: React.FC<ComputerUseSettingsProps> = ({ onSettingsChange }) => {
  const [settings, setSettings] = useState<ComputerUseSettings>({
    safetyMode: 'balanced',
    autoConfirmSafe: false,
    sessionTimeout: 30,
    screenshotQuality: 80,
    enableDetailedLogging: true,
    blockSensitiveDomains: true,
    maxActionsPerSession: 50
  })
  
  const [isOpen, setIsOpen] = useState(false)

  const updateSetting = <K extends keyof ComputerUseSettings>(
    key: K, 
    value: ComputerUseSettings[K]
  ) => {
    const newSettings = { ...settings, [key]: value }
    setSettings(newSettings)
    onSettingsChange?.(newSettings)
  }

  const resetToDefaults = () => {
    const defaultSettings: ComputerUseSettings = {
      safetyMode: 'balanced',
      autoConfirmSafe: false,
      sessionTimeout: 30,
      screenshotQuality: 80,
      enableDetailedLogging: true,
      blockSensitiveDomains: true,
      maxActionsPerSession: 50
    }
    setSettings(defaultSettings)
    onSettingsChange?.(defaultSettings)
  }

  const getSafetyModeDescription = (mode: string) => {
    switch (mode) {
      case 'strict':
        return 'Maximum security. All actions require confirmation.'
      case 'balanced':
        return 'Recommended. Safe actions proceed automatically.'
      case 'permissive':
        return 'Minimal checks. Use only if you trust the AI completely.'
      default:
        return ''
    }
  }

  const getSafetyModeColor = (mode: string) => {
    switch (mode) {
      case 'strict':
        return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400'
      case 'balanced':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400'
      case 'permissive':
        return 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400'
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400'
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="flex items-center gap-2">
          <Settings className="h-4 w-4" />
          Computer Use Settings
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5" />
            Computer Use Settings
          </DialogTitle>
          <DialogDescription>
            Configure safety, performance, and behavior settings for the Computer Use Agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Safety Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Shield className="h-5 w-5" />
                Safety & Security
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-sm font-medium">Safety Mode</Label>
                <div className="mt-2 space-y-2">
                  {(['strict', 'balanced', 'permissive'] as const).map((mode) => (
                    <div
                      key={mode}
                      className={`p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                        settings.safetyMode === mode
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-muted/50'
                      }`}
                      onClick={() => updateSetting('safetyMode', mode)}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium capitalize">{mode}</span>
                            <Badge variant="outline" className={getSafetyModeColor(mode)}>
                              {mode === 'strict' && <Shield className="h-3 w-3 mr-1" />}
                              {mode === 'balanced' && <AlertTriangle className="h-3 w-3 mr-1" />}
                              {mode === 'permissive' && <X className="h-3 w-3 mr-1" />}
                              {mode}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mt-1">
                            {getSafetyModeDescription(mode)}
                          </p>
                        </div>
                        {settings.safetyMode === mode && (
                          <Check className="h-5 w-5 text-primary" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="autoConfirm" className="text-sm font-medium">
                    Auto-confirm safe actions
                  </Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Automatically proceed with actions deemed safe by the AI
                  </p>
                </div>
                <Switch
                  id="autoConfirm"
                  checked={settings.autoConfirmSafe}
                  onCheckedChange={(checked) => updateSetting('autoConfirmSafe', checked)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="blockDomains" className="text-sm font-medium">
                    Block sensitive domains
                  </Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Prevent access to banking, payment, and other sensitive sites
                  </p>
                </div>
                <Switch
                  id="blockDomains"
                  checked={settings.blockSensitiveDomains}
                  onCheckedChange={(checked) => updateSetting('blockSensitiveDomains', checked)}
                />
              </div>
            </CardContent>
          </Card>

          {/* Performance Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Monitor className="h-5 w-5" />
                Performance & Limits
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-sm font-medium">
                  Session Timeout: {settings.sessionTimeout} minutes
                </Label>
                <Slider
                  value={[settings.sessionTimeout]}
                  onValueChange={([value]) => updateSetting('sessionTimeout', value)}
                  max={120}
                  min={5}
                  step={5}
                  className="mt-2"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Sessions will automatically end after this time period
                </p>
              </div>

              <div>
                <Label className="text-sm font-medium">
                  Screenshot Quality: {settings.screenshotQuality}%
                </Label>
                <Slider
                  value={[settings.screenshotQuality]}
                  onValueChange={([value]) => updateSetting('screenshotQuality', value)}
                  max={100}
                  min={30}
                  step={10}
                  className="mt-2"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Higher quality uses more bandwidth but provides better AI perception
                </p>
              </div>

              <div>
                <Label className="text-sm font-medium">
                  Max Actions per Session: {settings.maxActionsPerSession}
                </Label>
                <Slider
                  value={[settings.maxActionsPerSession]}
                  onValueChange={([value]) => updateSetting('maxActionsPerSession', value)}
                  max={200}
                  min={10}
                  step={10}
                  className="mt-2"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Limit the number of actions the AI can perform in one session
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Logging Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock className="h-5 w-5" />
                Logging & Monitoring
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="detailedLogging" className="text-sm font-medium">
                    Enable detailed logging
                  </Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Record detailed information about all AI actions and decisions
                  </p>
                </div>
                <Switch
                  id="detailedLogging"
                  checked={settings.enableDetailedLogging}
                  onCheckedChange={(checked) => updateSetting('enableDetailedLogging', checked)}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={resetToDefaults}>
            Reset to Defaults
          </Button>
          <Button onClick={() => setIsOpen(false)}>
            Save Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ComputerUseSettings