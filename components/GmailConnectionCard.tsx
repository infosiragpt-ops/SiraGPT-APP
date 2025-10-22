import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Mail, Shield, ArrowRight, CheckCircle } from 'lucide-react';
import { gmailService } from '@/lib/gmail-service';
import { toast } from 'sonner';

interface GmailConnectionCardProps {
  onConnect?: () => void;
  className?: string;
}

export const GmailConnectionCard: React.FC<GmailConnectionCardProps> = ({ 
  onConnect, 
  className = "" 
}) => {
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      const response = await gmailService.connectGmail();
      if (response.authUrl) {
        // Open Gmail OAuth in a new window
        window.open(response.authUrl, 'gmail-auth', 'width=500,height=600');
        onConnect?.();
      }
    } catch (error: any) {
      console.error('Gmail connection error:', error);
      toast.error('Failed to connect Gmail. Please try again.');
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <Card className={`border border-orange-200 bg-gradient-to-br from-orange-50 to-amber-50 ${className}`}>
      <CardHeader className="text-center pb-4">
        <div className="mx-auto w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center mb-3">
          <Mail className="h-6 w-6 text-orange-600" />
        </div>
        <CardTitle className="text-xl text-orange-900">Connect Gmail</CardTitle>
        <CardDescription className="text-orange-700">
          Connect your Gmail account to use email features in chat
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-sm text-orange-800">
            <CheckCircle className="h-4 w-4 text-orange-600 flex-shrink-0" />
            <span>Send emails with natural language</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-orange-800">
            <CheckCircle className="h-4 w-4 text-orange-600 flex-shrink-0" />
            <span>Read and search your emails</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-orange-800">
            <CheckCircle className="h-4 w-4 text-orange-600 flex-shrink-0" />
            <span>Reply and manage emails</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-orange-800">
            <Shield className="h-4 w-4 text-orange-600 flex-shrink-0" />
            <span>Secure OAuth authentication</span>
          </div>
        </div>
        
        <Button 
          onClick={handleConnect}
          disabled={isConnecting}
          className="w-full bg-orange-600 hover:bg-orange-700 text-white"
        >
          {isConnecting ? (
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Connecting...
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Connect Gmail Account
              <ArrowRight className="h-4 w-4" />
            </div>
          )}
        </Button>
        
        <p className="text-xs text-orange-600 text-center">
          Your emails remain private and secure. We only access what you explicitly request.
        </p>
      </CardContent>
    </Card>
  );
};

export default GmailConnectionCard;