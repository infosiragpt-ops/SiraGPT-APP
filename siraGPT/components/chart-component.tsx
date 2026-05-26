"use client"

import * as React from "react"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LineChart, Line, PieChart, Pie, Cell, LabelList, ResponsiveContainer, Label, AreaChart, Area } from 'recharts';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042'];

const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload;
        const name = data.name || label;
        return (
            <div className="custom-tooltip" style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)', padding: '10px', border: '1px solid #ccc', color: 'white' }}>
                <p className="label">{`${name} : ${payload[0].value}`}</p>
            </div>
        );
    }

    return null;
};

// Chart Component
const ChartComponent = ({ content }: { content: string }) => {
    try {
        const chartData = JSON.parse(content);
        const { type, data, config } = chartData;

        if (!type || !data || !config) {
            return null;
        }

        const renderChart = () => {
            switch (type) {
                case 'bar':
                    return (
                        <BarChart data={data}>
                            <defs>
                                <linearGradient id="colorUv" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8} />
                                    <stop offset="95%" stopColor="#8884d8" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey={config.xAxisKey}>
                                {config.xAxisLabel && <Label value={config.xAxisLabel} offset={-5} position="insideBottom" />}
                            </XAxis>
                            <YAxis>
                                {config.yAxisLabel && <Label value={config.yAxisLabel} angle={-90} position="insideLeft" style={{ textAnchor: 'middle' }} />}
                            </YAxis>
                            <Tooltip content={<CustomTooltip />} />
                            <Legend />
                            <Bar dataKey={config.dataKey} fill="url(#colorUv)">
                                <LabelList dataKey={config.dataKey} position="top" />
                            </Bar>
                        </BarChart>
                    );
                case 'line':
                    return (
                        <LineChart data={data}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey={config.xAxisKey}>
                                {config.xAxisLabel && <Label value={config.xAxisLabel} offset={-5} position="insideBottom" />}
                            </XAxis>
                            <YAxis>
                                {config.yAxisLabel && <Label value={config.yAxisLabel} angle={-90} position="insideLeft" style={{ textAnchor: 'middle' }} />}
                            </YAxis>
                            <Tooltip content={<CustomTooltip />} />
                            <Legend />
                            <Line type="monotone" dataKey={config.dataKey} stroke={config.fill} />
                        </LineChart>
                    );
                case 'pie':
                    return (
                        <PieChart>
                            <Pie data={data} dataKey={config.dataKey} nameKey={config.xAxisKey} cx="50%" cy="50%" outerRadius={100} fill={config.fill} label>
                                {data.map((entry: any, index: number) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                            </Pie>
                            <Tooltip content={<CustomTooltip />} />
                            <Legend />
                        </PieChart>
                    );
                case 'area':
                    return (
                        <AreaChart data={data}>
                            <defs>
                                <linearGradient id="colorUv" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8} />
                                    <stop offset="95%" stopColor="#8884d8" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey={config.xAxisKey}>
                                {config.xAxisLabel && <Label value={config.xAxisLabel} offset={-5} position="insideBottom" />}
                            </XAxis>
                            <YAxis>
                                {config.yAxisLabel && <Label value={config.yAxisLabel} angle={-90} position="insideLeft" style={{ textAnchor: 'middle' }} />}
                            </YAxis>
                            <Tooltip content={<CustomTooltip />} />
                            <Legend />
                            <Area type="monotone" dataKey={config.dataKey} stroke="#8884d8" fill="url(#colorUv)" />
                        </AreaChart>
                    );
                default:
                    return <div />;
            }
        };

        return (
            <div style={{ width: '100%', height: 300 }}>
                {config.title && <h3 style={{ textAlign: 'center' }}>{config.title}</h3>}
                <ResponsiveContainer>
                    {renderChart()}
                </ResponsiveContainer>
            </div>
        );

    } catch (error) {
        return null;
    }
};

export default ChartComponent;
