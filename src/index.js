const slug = require('slug');
const express = require('express');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const Client = require('@liamcottle/sungrow-eyem4-api');

const METRICS_NAMESPACE = "eyem4";

function formatMetricName(name) {
    const cleanMetricName = slug(name, "_");
    return `${METRICS_NAMESPACE}_${cleanMetricName}`;
}

function formatMetricLabels(labels) {

    const formattedLabels = Object.entries(labels).map(([label, value]) => {
        return `${label}="${value}"`;
    }).join(" ");

    return "{" + formattedLabels + "}";

}

function formatMetric(name, type, labels, value) {
    const formattedMetricName = formatMetricName(name);
    const formattedMetricLabels = formatMetricLabels(labels);
    return [
        `# TYPE ${formattedMetricName} ${type}`,
        `${formattedMetricName}${formattedMetricLabels} ${value}`,
    ].join("\n");
}

function showUsage() {
    const usage = commandLineUsage([
        {
            header: 'Sungrow EyeM4 Exporter',
            content: 'A Prometheus exporter for the Sungrow EyeM4 Dongle.',
        },
        {
            header: 'Usage',
            content: '$ sungrow-eyem4-exporter <options> <command>'
        },
        {
            header: 'Command List',
            content: [
                { name: 'help', summary: 'Print this usage guide.' },
                { name: 'serve', summary: 'Serves prometheus style metrics at /metrics' },
            ]
        },
        {
            header: 'Options',
            optionList: [
                {
                    name: 'ip',
                    description: 'IP address of the dongle. (e.g: 192.168.1.175)',
                },
                {
                    name: 'timeout',
                    description: 'Timeout in milliseconds for querying the dongle. (e.g: 10000)',
                },
                {
                    name: 'listen-port',
                    description: 'Port the exporter will listen on. (e.g: 8080)',
                },
            ],
        },
    ]);
    console.log(usage);
}

async function run() {

    // parse command line args
    const options = commandLineArgs([
        { name: 'command', type: String, defaultOption: true },
        { name: 'ip', type: String },
        { name: 'listen-port', type: String },
    ]);

    // run command
    switch(options.command){
        case 'serve': {
            await serve(options);
            break;
        }
        case 'help': {
            showUsage();
            break;
        }
        default: {
            showUsage();
            break;
        }
    }

}

async function getMetrics(ip, timeout = 10000) {
    return new Promise((resolve, reject) => {
        try {

            // reject after provided timeout
            if(timeout != null){
                setTimeout(() => {
                    reject("timeout");
                }, timeout);
            }

            const client = new Client(ip);

            // handle error
            client.on("error", (error) => {
                reject(error);
            });

            // wait until connected
            client.on("connected", async () => {

                // authenticate
                await client.authenticate();

                const lines = [];

                // state
                const state = await client.getState();
                lines.push(formatMetric("state_total_alarm", "gauge", { "ip": ip }, state.total_alarm));
                lines.push(formatMetric("state_total_fault", "gauge", { "ip": ip }, state.total_fault));

                // realtime data
                const devices = await client.getDeviceList();
                for(const device of devices.list){
                    const response = await client.getDeviceRealtimeData(device.id);
                    for(const item of response.list){
                        if(!isNaN(item.data_value)){
                            lines.push(formatMetric(`realtime_data_${item.data_name}`, "gauge", {
                                "ip": ip,
                                "device_id": device.id,
                                "device_type": device.dev_type,
                                "device_sn": device.dev_sn,
                                "device_name": device.dev_name,
                                "device_model": device.dev_model,
                                "device_port_name": device.port_name,
                            }, item.data_value));
                        }
                    }
                }

                // dc data
                const response = await client.getDeviceDCData(1); // fixme
                for(const item of response.list){

                    const metricName = `dc_data_${item.name}`;

                    // voltage
                    if(!isNaN(item.voltage)){
                        lines.push(formatMetric(`${metricName}_voltage`, "gauge", {
                            "ip": ip,
                            "device_id": 1,
                        }, item.voltage));
                    }

                    // current
                    if(!isNaN(item.current)){
                        lines.push(formatMetric(`${metricName}_current`, "gauge", {
                            "ip": ip,
                            "device_id": 1,
                        }, item.current));
                    }

                }

                // we are done here
                client.disconnect();

                // return metrics
                resolve(lines.join("\n"));

            });

            // connect
            client.connect();

        } catch(e) {
            reject(e);
        }
    });
}

async function serve(options) {

    // get options
    const ip = options['ip'];
    const listenPort = options['listen-port'] || 8080;
    const timeout = options['timeout'] || 10000;

    // make sure ip is valid
    if(ip == null){
        console.error("Invalid IP");
        return;
    }

    // make listen port is valid
    if(isNaN(listenPort)){
        console.error("Invalid Listen Port");
        return;
    }

    // start express server
    const app = express();
    app.listen(listenPort);

    // handle metrics
    app.get("/metrics", async (req, res) => {
        try {

            // fetch metrics
            const metrics = await getMetrics(ip, timeout);

            // return metrics as response
            res.header("Content-Type", "text/plain");
            res.send(metrics);

        } catch(e) {
            res.status(500).json({
                "message": e.toString(),
            });
        }
    });

    // log that server is running
    console.log(`Listening on port ${listenPort}`);

}

run();
