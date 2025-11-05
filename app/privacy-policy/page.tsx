"use client"
import React from 'react';
import { motion } from 'framer-motion';
import { Mail, Building, MapPin } from 'lucide-react';

const PrivacyPolicyPage = () => {
    return (
        <div className="min-h-screen bg-gradient-to-b from-black to-gray-950 text-white">
            <div className="container mx-auto px-6 py-24">
                <motion.div
                    initial={{ opacity: 0, y: -50 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5 }}
                    className="text-center mb-12"
                >
                    <h1 className="text-5xl md:text-7xl font-bold tracking-tight bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                        Privacy Policy
                    </h1>
                    <p className="text-lg text-gray-400 mt-4">Last Updated: November 5, 2025</p>
                </motion.div>

                <div className="max-w-4xl mx-auto bg-gray-900/50 border border-white/10 p-8 rounded-lg backdrop-blur-sm">
                    <div className="space-y-8">
                        <section>
                            <h2 className="text-2xl font-semibold text-gray-200 mb-4">1. Introduction</h2>
                            <p className="text-gray-400 leading-relaxed">
                                Welcome to our application. We are committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our application. If you do not agree with the terms of this policy, please do not access the application.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-2xl font-semibold text-gray-200 mb-4">2. Information We Collect</h2>
                            <p className="text-gray-400 leading-relaxed">
                                We may collect personally identifiable information, such as your name and email address, when you register. To provide enhanced features, our application uses a Model Context Protocol (MCP) server to interact with Google services, which may include accessing your Gmail, Google Calendar, and Google Drive data with your permission.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-2xl font-semibold text-gray-200 mb-4">3. How We Use Your Information</h2>
                            <p className="text-gray-400 leading-relaxed">
                                We use your information to create and manage your account, provide AI-powered services, and integrate with Google Services to enhance application features. Your data helps us improve our services and communicate with you effectively.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-2xl font-semibold text-gray-200 mb-4">4. Disclosure of Your Information</h2>
                            <p className="text-gray-400 leading-relaxed">
                                We do not share, sell, or trade your information with third parties for commercial purposes. Your information may be disclosed to comply with legal obligations, to protect our rights, or with third-party service providers who perform services for us.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-2xl font-semibold text-gray-200 mb-4">5. Data from Google Services</h2>
                            <div className="text-gray-400 leading-relaxed">
                                <p>Our application uses an MCP server to interact with Google services. When you grant us permission, we may access:</p>
                                <ul className="list-disc list-inside mt-2 space-y-1">
                                    <li><strong>Gmail:</strong> To summarize emails, compose replies, or create tasks. We do not store your emails.</li>
                                    <li><strong>Google Calendar:</strong> To create events, set reminders, or check your availability. We do not store your calendar data.</li>
                                    <li><strong>Google Drive:</strong> To find information, summarize documents, or create new files. We only access files you explicitly authorize.</li>
                                </ul>
                                <p className="mt-2 text-sm">
                                    Our use and transfer of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-indigo-400 hover:underline" target="_blank" rel="noopener noreferrer">Google API Services User Data Policy</a>.
                                </p>
                            </div>
                        </section>

                        <section>
                            <h2 className="text-2xl font-semibold text-gray-200 mb-4">6. Security of Your Information</h2>
                            <p className="text-gray-400 leading-relaxed">
                                We use administrative, technical, and physical security measures to help protect your personal information. While we have taken reasonable steps to secure your data, no security measures are perfect, and no method of data transmission can be guaranteed against interception or misuse.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-2xl font-semibold text-gray-200 mb-4">7. Your Rights and Choices</h2>
                            <p className="text-gray-400 leading-relaxed">
                                You may review or change the information in your account or terminate your account at any time by logging into your account settings or contacting us. You can also revoke our access to your Google data through your Google account security settings.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-2xl font-semibold text-gray-200 mb-4">8. Changes to This Privacy Policy</h2>
                            <p className="text-gray-400 leading-relaxed">
                                We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page. You are advised to review this Privacy Policy periodically for any changes.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-2xl font-semibold text-gray-200 mb-4">9. Contact Us</h2>
                            <div className="bg-gray-800/50 p-6 rounded-lg border border-white/10">
                                <p className="text-gray-400 leading-relaxed mb-6">
                                    If you have questions or comments about this Privacy Policy, please contact us at:
                                </p>
                                <div className="space-y-4">
                                    <div className="flex items-center">
                                        <Mail className="h-5 w-5 text-indigo-400 mr-4" />
                                        <span className="text-gray-300">infosiragpt@gmail.com</span>
                                    </div>
                                    <div className="flex items-center">
                                        <Building className="h-5 w-5 text-indigo-400 mr-4" />
                                        <span className="text-gray-300">siragpt.com S.A</span>
                                    </div>
                                    <div className="flex items-center">
                                        <MapPin className="h-5 w-5 text-indigo-400 mr-4" />
                                        <span className="text-gray-300">San Isidro, Lima, Lima</span>
                                    </div>
                                </div>
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PrivacyPolicyPage;
